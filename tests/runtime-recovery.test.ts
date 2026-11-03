import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
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
      const windows = process.platform === 'win32'
      const floodScript = join(directory, windows ? 'flood.cmd' : 'flood.sh')
      const resumedScript = join(directory, windows ? 'after-attach.cmd' : 'after-attach.sh')
      // Electron is a GUI executable on Windows. An interactive cmd prompt does not wait for it;
      // native batch files do. The shell marker proves that all flood output has drained and the child exited.
      await writeFile(
        floodScript,
        windows
          ? `@echo off\r\n"${escapedExecutable}" -e "process.stdout.write('x'.repeat(400000))"\r\necho __FLOOD_COMPLETE__\r\n`
          : `"${escapedExecutable}" -e "process.stdout.write('x'.repeat(400000))"\nprintf '\\n__FLOOD_COMPLETE__\\n'\n`,
      )
      await writeFile(
        resumedScript,
        `${windows ? '@echo off\r\n' : ''}"${escapedExecutable}" -e "console.log('__AFTER_'+'ATTACH__')"${windows ? '\r\n' : '\n'}`,
      )
      const execute = (script: string) =>
        terminals.write(id, `${windows ? '' : 'sh '}"${script}"\r`)
      execute(floodScript)
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
      // Reattach while genuinely backpressured, then finish the producer before sending new shell input.
      await vi.waitFor(
        () => {
          terminals.ack(id, 1000000)
          expect(output).toContain('__FLOOD_COMPLETE__')
        },
        { timeout: 10000 },
      )
      execute(resumedScript)
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
  it.skipIf(process.platform === 'win32')(
    'confirms a natural PTY leader exit before releasing its isolated group and leaves another terminal healthy',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'hub-terminal-natural-exit-'))
      const previousShell = process.env.SHELL
      const isolatedShell = join(directory, 'isolated-shell.sh')
      await writeFile(isolatedShell, '#!/bin/sh\nexec /bin/zsh -f "$@"\n', { mode: 0o755 })
      // Preserve TerminalService's real forkpty path while excluding user login/interactive startup files.
      process.env.SHELL = isolatedShell
      const output = new Map<string, string>()
      const ownership: ProcessOwnershipEvent[] = []
      setProcessOwnershipObserver((event) => ownership.push(event))
      const terminals = new TerminalService((event) => {
        if (event.data) output.set(event.id, (output.get(event.id) || '') + event.data)
      })
      const processGroup = (pid: number) =>
        Number(
          execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim(),
        )
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      }
      try {
        const first = await terminals.create(directory, 80, 24, 'natural-exit')
        const other = await terminals.create(directory, 80, 24, 'healthy')
        terminals.write(first, `printf '__PTY_ROOT_%s__\\n' "$$"\r`)
        terminals.write(other, `printf '__OTHER_ROOT_%s__\\n' "$$"\r`)
        // Typed input echo is not readiness: wait for each shell to execute printf and emit its numeric PID.
        await vi.waitFor(
          () => {
            expect(output.get(first)).toMatch(/__PTY_ROOT_\d+__/)
            expect(output.get(other)).toMatch(/__OTHER_ROOT_\d+__/)
          },
          { timeout: 10000 },
        )
        const root = Number(/__PTY_ROOT_(\d+)__/.exec(output.get(first)!)![1])
        const otherRoot = Number(/__OTHER_ROOT_(\d+)__/.exec(output.get(other)!)![1])
        expect(processGroup(root)).toBe(root)
        expect(processGroup(otherRoot)).toBe(otherRoot)
        expect(otherRoot).not.toBe(root)
        const ready = join(directory, 'child-ready'),
          exit = join(directory, 'exit-parent')
        const childScript = join(directory, 'survivor.cjs'),
          parentScript = join(directory, 'leader.cjs')
        await writeFile(
          childScript,
          `process.on('SIGHUP',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`,
        )
        await writeFile(
          parentScript,
          `const fs=require('node:fs'),{spawn}=require('node:child_process');const child=spawn(process.execPath,[${JSON.stringify(childScript)}],{stdio:'ignore'});let announced=false;setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})&&!announced){announced=true;process.stdout.write('__CHILD_PID_'+child.pid+'__\\n')}if(fs.existsSync(${JSON.stringify(exit)}))process.exit(0)},10)`,
        )
        terminals.write(
          first,
          `exec "${process.execPath.replace(/"/g, '\\"')}" "${parentScript}"\r`,
        )
        await vi.waitFor(() => expect(output.get(first)).toMatch(/__CHILD_PID_\d+__/), {
          timeout: 10000,
        })
        const child = Number(/__CHILD_PID_(\d+)__/.exec(output.get(first)!)![1])
        expect(alive(child)).toBe(true)
        expect(processGroup(child)).toBe(root)
        await writeFile(exit, 'exit now')
        await vi.waitFor(() => expect(terminals.list('natural-exit')[0].exitCode).toBe(0), {
          timeout: 10000,
        })
        await vi.waitFor(() => expect(alive(child)).toBe(false), { timeout: 10000 })
        expect(
          ownership.some((event) => event.action === 'release' && event.process.pid === root),
        ).toBe(true)
        expect(alive(otherRoot)).toBe(true)
        expect(terminals.list('healthy')[0].exitCode).toBeUndefined()
        terminals.write(other, `printf '__OTHER_%s__\\n' 'STILL_RUNNING'\r`)
        await vi.waitFor(() => expect(output.get(other)).toContain('__OTHER_STILL_RUNNING__'), {
          timeout: 10000,
        })
      } finally {
        await terminals.closeAll()
        if (previousShell === undefined) delete process.env.SHELL
        else process.env.SHELL = previousShell
        await rm(directory, { recursive: true, force: true })
      }
    },
    25000,
  )
})
