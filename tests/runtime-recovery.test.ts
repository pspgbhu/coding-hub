import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  launch,
  setProcessOwnershipObserver,
  terminateOwnedProcesses,
  terminateProcessTree,
  finalizeOwnedChild,
  type ProcessOwnershipEvent,
} from '../src/runtime/process'
import { TerminalService } from '../src/runtime/terminal'

afterEach(() => setProcessOwnershipObserver(() => {}))

describe('runtime recovery', () => {
  it('cleans descendants holding inherited pipes after the parent exits naturally', async () => {
    const source = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});process.stdout.write(String(child.pid));setTimeout(()=>process.exit(0),100)`
    const parent = launch(process.execPath, ['-e', source])
    let output = ''
    parent.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    try {
      await once(parent, 'exit')
      const descendant = Number(output)
      expect(descendant).toBeGreaterThan(1)
      await finalizeOwnedChild(parent)
      await vi.waitFor(
        () => {
          let alive = true
          try {
            process.kill(descendant, 0)
          } catch {
            alive = false
          }
          expect(alive).toBe(false)
        },
        { timeout: 10000 },
      )
      await vi.waitFor(() => expect(parent.stdout.destroyed).toBe(true))
    } finally {
      await terminateProcessTree(parent)
    }
  }, 20000)
  it('supervises registered process identities and refuses a mismatched birth identity', async () => {
    const events: ProcessOwnershipEvent[] = []
    setProcessOwnershipObserver((event) => events.push(event))
    const child = launch(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
    const unrelated = launch(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
    try {
      await vi.waitFor(
        () => expect(events.filter((event) => event.action === 'register')).toHaveLength(2),
        { timeout: 10000 },
      )
      const owner = events.find((event) => event.process.pid === child.pid)!.process
      const other = events.find((event) => event.process.pid === unrelated.pid)!.process
      await terminateOwnedProcesses([owner, { ...other, started: 'mismatched-birth-identity' }])
      await vi.waitFor(() =>
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true),
      )
      expect(unrelated.exitCode).toBeNull()
      expect(unrelated.signalCode).toBeNull()
      expect(
        events.some((event) => event.action === 'release' && event.process.id === owner.id),
      ).toBe(true)
    } finally {
      await Promise.allSettled([terminateProcessTree(child), terminateProcessTree(unrelated)])
    }
  }, 20000)

  it('reattaches a live PTY with bounded replay and resumes output after a lost renderer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hub-terminal-recovery-'))
    let output = ''
    const terminals = new TerminalService((event) => {
      if (event.data) output += event.data
    })
    try {
      const id = await terminals.create(directory, 80, 24, 'workspace')
      const escapedExecutable = process.execPath.replace(/"/g, '\\"')
      terminals.write(id, `"${escapedExecutable}" -e "process.stdout.write('x'.repeat(400000))"\r`)
      await vi.waitFor(() => expect(output.length).toBeGreaterThanOrEqual(256 * 1024), {
        timeout: 10000,
      })
      const before = terminals.attach(id)
      expect(before).toMatchObject({
        id,
        workspaceId: 'workspace',
        cwd: await realpath(directory),
        cols: 80,
        rows: 24,
      })
      expect(before.buffer!.length).toBeLessThanOrEqual(256 * 1024)
      terminals.ack(id, 1000000)
      terminals.write(id, `"${escapedExecutable}" -e "console.log('__AFTER_'+'ATTACH__')"\r`)
      // ACK a new consumer's data, as the renderer does after xterm has rendered it.
      await vi.waitFor(
        () => {
          terminals.ack(id, 1000000)
          expect(output).toContain('__AFTER_ATTACH__')
        },
        { timeout: 10000 },
      )
      expect(terminals.list('workspace')).toHaveLength(1)
      terminals.resize(id, 100, 30)
      expect(terminals.attach(id)).toMatchObject({ cols: 100, rows: 30 })
      await terminals.close(id)
      expect(terminals.attach(id).exitCode).toBeDefined()
    } finally {
      await terminals.closeAll()
      await rm(directory, { recursive: true, force: true })
    }
  }, 25000)
})
