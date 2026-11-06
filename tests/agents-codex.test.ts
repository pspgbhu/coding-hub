import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../src/shared/runtime'
import type { AgentEvent } from '../src/shared/types'

const fixtures = vi.hoisted(() => ({ script: '', cleanupFails: false }))
vi.mock('../src/runtime/process', () => ({
  resolveCommand: async () => process.execPath,
  launch: () => spawn(process.execPath, ['-e', fixtures.script], { stdio: 'pipe' }),
  terminateProcessTree: async (child: ReturnType<typeof spawn>) => {
    if (fixtures.cleanupFails) throw new Error('Fixture process cleanup failed')
    child.kill()
  },
  finalizeOwnedChild: async () => {},
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
  fixtures.cleanupFails = false
  for (const child of children.splice(0)) child.kill()
})

describe('Codex public app-server protocol', () => {
  it('discovers paginated models with native reasoning options and tolerates older metadata', async () => {
    fixtures.script = `
      const rl=require('readline').createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
      rl.on('line',line=>{const m=JSON.parse(line);
        if(m.method==='initialize')send({id:m.id,result:{}});
        if(m.method==='model/list'){
          if(m.params.includeHidden!==false)process.exit(8);
          if(!m.params.cursor)send({id:m.id,result:{data:[{id:'reasoner',displayName:'Reasoner',description:'Native model description',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Balanced'},{reasoningEffort:'high',description:'Thorough'}]},{id:'legacy'}],nextCursor:'page-2'}});
          else if(m.params.cursor==='page-2')send({id:m.id,result:{data:[{id:'plain',model:'plain',isDefault:false,supportedReasoningEfforts:[]}],nextCursor:null}});
          else process.exit(9);
        }
      });
    `
    const adapter = new CodexAdapter(() => {})
    try {
      expect(await adapter.models(process.execPath, '/tmp')).toEqual([
        {
          id: 'reasoner',
          name: 'Reasoner',
          description: 'Native model description',
          isDefault: true,
          reasoning: {
            kind: 'effort',
            default: 'medium',
            options: [
              { value: 'medium', label: 'medium', description: 'Balanced' },
              { value: 'high', label: 'high', description: 'Thorough' },
            ],
          },
        },
        { id: 'legacy', name: 'legacy' },
        { id: 'plain', name: 'plain', isDefault: false },
      ])
    } finally {
      await adapter.close()
    }
  })
  it('rejects repeated model page cursors instead of looping indefinitely', async () => {
    fixtures.script = `
      const rl=require('readline').createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
      rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({id:m.id,result:{}});if(m.method==='model/list')send({id:m.id,result:{data:[],nextCursor:'repeated'}})});
    `
    const adapter = new CodexAdapter(() => {})
    try {
      await expect(adapter.models(process.execPath, '/tmp')).rejects.toThrow(
        'repeated a page cursor',
      )
    } finally {
      await adapter.close()
    }
  })
  it.each([
    { name: 'CLI defaults', model: undefined, reasoningOption: undefined, nativeId: undefined },
    {
      name: 'new explicit selection',
      model: 'reasoner',
      reasoningOption: 'high',
      nativeId: undefined,
    },
    {
      name: 'resumed model default',
      model: 'reasoner',
      reasoningOption: 'medium',
      nativeId: 'existing',
    },
  ])(
    'sends $name through the native turn parameters',
    async ({ model, reasoningOption, nativeId }) => {
      fixtures.script = `
      const expected=${JSON.stringify({ model, effort: reasoningOption })};const existing=${JSON.stringify(nativeId ?? null)};
      const rl=require('readline').createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
      rl.on('line',line=>{const m=JSON.parse(line);
        if(m.method==='initialize')send({id:m.id,result:{}});
        if(m.method==='thread/start'||m.method==='thread/resume'){
          if(m.method!==(existing?'thread/resume':'thread/start')||(existing&&m.params.threadId!==existing))process.exit(8);
          send({id:m.id,result:{thread:{id:existing||'created'},reasoningEffort:'high'}});
        }
        if(m.method==='turn/start'){
          const actual=Object.fromEntries(['model','effort'].filter(k=>Object.hasOwn(m.params,k)).map(k=>[k,m.params[k]]));
          if(JSON.stringify(actual)!==JSON.stringify(expected))process.exit(9);
          send({id:m.id,result:{turn:{id:'turn'}}});
          send({method:'turn/completed',params:{threadId:existing||'created',turn:{id:'turn',status:'completed'}}});
        }
      });
    `
      const events: AgentEvent[] = []
      const adapter = new CodexAdapter((event) => events.push(event))
      try {
        await adapter.send(
          { ...context, session: { ...context.session, model, reasoningOption, nativeId } },
          'Hello',
          'selection',
        )
        await vi.waitFor(() => expect(events.some((event) => event.kind === 'done')).toBe(true))
        expect(events.filter((event) => event.kind === 'error')).toEqual([])
        expect(events.find((event) => event.kind === 'session')?.nativeId).toBe(
          nativeId ?? 'created',
        )
      } finally {
        await adapter.close()
      }
    },
  )
  it('keeps a protocol-failed turn locked when child cleanup cannot be confirmed', async () => {
    fixtures.script = `const rl=require('readline').createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({id:m.id,result:{}});if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'broken'}}});if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'broken-turn'}}});process.stdout.write('{invalid-json}\\n')}})`
    const events: AgentEvent[] = []
    const adapter = new CodexAdapter((event) => events.push(event))
    fixtures.cleanupFails = true
    try {
      await adapter.send(context, 'Work', 'broken')
      await vi.waitFor(() =>
        expect(events.at(-1)).toMatchObject({ kind: 'status', status: 'stop_failed' }),
      )
      expect(events.some((event) => event.kind === 'done')).toBe(false)
      await expect(adapter.send(context, 'Other work', 'other')).rejects.toThrow('already running')
      fixtures.cleanupFails = false
      await adapter.interrupt(context.session.id)
      expect(events.at(-1)).toMatchObject({ kind: 'done', status: 'interrupted' })
    } finally {
      fixtures.cleanupFails = false
      await adapter.close()
    }
  })
  it('forwards original long tool chunks and complete snapshots without truncation', async () => {
    fixtures.script = `
      const rl=require('readline').createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
      rl.on('line',line=>{const m=JSON.parse(line);
        if(m.method==='initialize')send({id:m.id,result:{}});
        if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'long-thread'}}});
        if(m.method==='turn/start'){
          send({id:m.id,result:{turn:{id:'long-turn'}}});
          send({method:'item/commandExecution/outputDelta',params:{threadId:'long-thread',itemId:'command',delta:'x'.repeat(90000)}});
          send({method:'item/completed',params:{threadId:'long-thread',item:{id:'command',type:'commandExecution',aggregatedOutput:'x'.repeat(90000),status:'completed'}}});
          send({method:'turn/completed',params:{threadId:'long-thread',turn:{id:'long-turn',status:'completed'}}});
        }
      });
    `
    const events: AgentEvent[] = []
    const adapter = new CodexAdapter((event) => events.push(event))
    await adapter.send(context, 'Run', 'long')
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'done')).toBe(true))
    expect(events.find((event) => event.outputDelta)?.output).toHaveLength(90000)
    expect(
      events.find((event) => event.kind === 'tool' && event.state === 'completed'),
    ).toMatchObject({ outputDelta: false, output: 'x'.repeat(90000) })
    await adapter.close()
  })
  it('presents permission profiles, transmits native images, and records the selected scope', async () => {
    fixtures.script = `
      const rl=require('readline').createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
      rl.on('line',line=>{const m=JSON.parse(line);
        if(m.method==='initialize')send({id:m.id,result:{}});
        if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'profile-thread'}}});
        if(m.method==='turn/start'){
          if(m.params.input[1].type!=='image'||!m.params.input[1].url.startsWith('data:image/png;base64,'))process.exit(8);
          send({id:m.id,result:{turn:{id:'profile-turn'}}});
          send({id:10,method:'item/permissions/requestApproval',params:{permissions:{network:{enabled:true}}}});
        }
        if(m.id===10){
          if(m.result.permissions.network.enabled!==true||m.result.scope!=='session')process.exit(9);
          send({method:'turn/completed',params:{threadId:'profile-thread',turn:{id:'profile-turn',status:'completed'}}});
        }
      });
    `
    const events: AgentEvent[] = []
    const adapter = new CodexAdapter((event) => {
      events.push(event)
      if (event.kind === 'approval')
        void adapter.respond('session', event.requestId!, { decision: 'accept', scope: 'session' })
    })
    await adapter.send(
      {
        ...context,
        input: {
          text: 'Inspect',
          context: [
            {
              id: 'image',
              kind: 'image',
              name: 'sample.png',
              dataUrl: 'data:image/png;base64,aGVsbG8=',
            },
          ],
        },
      },
      'Inspect',
      'profile',
    )
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'done')).toBe(true))
    expect(events.find((event) => event.kind === 'requestResolved')).toMatchObject({
      resolution: 'approved',
      scope: 'session',
    })
    expect(events.filter((event) => event.kind === 'error')).toEqual([])
    await adapter.close()
  })
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
    expect(
      events.find((event) => event.kind === 'requestResolved' && event.requestId === '92'),
    ).toMatchObject({ answers: { format: ['JSON'] }, resolution: 'approved' })
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
