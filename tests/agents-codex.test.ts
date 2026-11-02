import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../src/shared/runtime'
import type { AgentEvent } from '../src/shared/types'

const fixtures = vi.hoisted(() => ({ script: '' }))
vi.mock('../src/runtime/process', () => ({
  resolveCommand: async () => process.execPath,
  launch: () => spawn(process.execPath, ['-e', fixtures.script], { stdio: 'pipe' }),
  terminateProcessTree: async (child: ReturnType<typeof spawn>) => {
    child.kill()
  },
}))
import { CodexAdapter, CodexRpc } from '../src/runtime/adapters/codex'

const context: AgentContext = {
  cwd: '/tmp',
  session: {
    id: 'session',
    projectId: 'project',
    provider: 'codex',
    title: 'Test',
    status: 'idle',
    archived: false,
    createdAt: 0,
    updatedAt: 0,
  },
}
const children: ReturnType<typeof spawn>[] = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill()
})

describe('Codex public app-server protocol', () => {
  it('correlates out-of-order responses and preserves UTF-8 NDJSON', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      let first; const rl=require('readline').createInterface({input:process.stdin});
      rl.on('line',line=>{ const m=JSON.parse(line); if(!first) first=m; else {
        process.stdout.write(JSON.stringify({id:m.id,result:'second'})+'\\n');
        const b=Buffer.from(JSON.stringify({id:first.id,result:'你好'})+'\\n');
        for(const byte of b)process.stdout.write(Buffer.from([byte]));
      }});
    `,
      ],
      { stdio: 'pipe' },
    )
    children.push(child)
    const rpc = new CodexRpc(
      child,
      () => {},
      () => {},
    )
    const first = rpc.request('first', {})
    const second = rpc.request('second', {})
    expect(await Promise.all([first, second])).toEqual(['你好', 'second'])
    rpc.close()
  })
  it('starts a native thread, answers approvals and questions, then completes one app turn', async () => {
    fixtures.script = `
      const rl=require('readline').createInterface({input:process.stdin});
      function send(m){process.stdout.write(JSON.stringify(m)+'\\n')}
      rl.on('line',line=>{const m=JSON.parse(line);
        if(m.method==='initialize')send({id:m.id,result:{}});
        if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'native-thread'}}});
        if(m.method==='turn/start'){
          send({id:m.id,result:{turn:{id:'native-turn'}}});
          send({id:91,method:'item/commandExecution/requestApproval',params:{threadId:'native-thread',turnId:'native-turn',itemId:'cmd',command:'echo hi',availableDecisions:['accept','decline']}});
        }
        if(m.id===91){
          if(m.result.decision!=='accept')process.exit(6);
          send({id:92,method:'item/tool/requestUserInput',params:{questions:[{id:'format',question:'Format?',options:[{label:'JSON',description:'structured'}]}]}});
        }
        if(m.id===92){
          if(m.result.answers.format.answers[0]!=='JSON')process.exit(7);
          send({method:'item/agentMessage/delta',params:{threadId:'native-thread',turnId:'native-turn',itemId:'answer',delta:'你好'}});
          send({method:'turn/completed',params:{threadId:'native-thread',turn:{id:'native-turn',status:'completed'}}});
        }
      });
    `
    const events: AgentEvent[] = []
    const adapter = new CodexAdapter((event) => {
      events.push(event)
      if (event.kind === 'approval')
        void adapter.respond('session', event.requestId!, { decision: 'accept' })
      if (event.kind === 'question')
        void adapter.respond('session', event.requestId!, { answers: { format: ['JSON'] } })
    })
    await adapter.send(context, 'Hi', 'app-turn')
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'done')).toBe(true))
    expect(events.find((event) => event.kind === 'session')?.nativeId).toBe('native-thread')
    expect(events.find((event) => event.kind === 'text')).toMatchObject({
      text: '你好',
      itemId: 'answer',
      turnId: 'app-turn',
    })
    expect(events.filter((event) => event.kind === 'done')).toHaveLength(1)
    expect(events.some((event) => event.kind === 'error')).toBe(false)
    await adapter.close()
  })
  it('interrupts an in-progress turn without duplicate done events', async () => {
    fixtures.script = `
      const rl=require('readline').createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
      rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({id:m.id,result:{}});
      if(m.method==='thread/resume')send({id:m.id,result:{thread:{id:'existing'}}});
      if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'work'}}});send({method:'item/agentMessage/delta',params:{threadId:'existing',turnId:'work',itemId:'text',delta:'working'}})}
      if(m.method==='turn/interrupt'){send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId:'existing',turn:{id:'work',status:'interrupted'}}})}});
    `
    const events: AgentEvent[] = []
    const adapter = new CodexAdapter((event) => events.push(event))
    await adapter.send(
      { ...context, session: { ...context.session, nativeId: 'existing' } },
      'continue',
      'next-turn',
    )
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'text')).toBe(true))
    await adapter.interrupt('session')
    await vi.waitFor(() => expect(events.filter((event) => event.kind === 'done')).toHaveLength(1))
    expect(events.at(-1)?.status).toBe('interrupted')
    await adapter.close()
  })
})
