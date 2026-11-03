import { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../src/shared/runtime'
import type { AgentEvent } from '../src/shared/types'

const fixture = vi.hoisted(() => ({ script: '', args: [] as string[] }))
vi.mock('../src/runtime/process', () => ({
  resolveCommand: async () => process.execPath,
  getProcessEnvironment: (extra?: NodeJS.ProcessEnv) => ({ ...process.env, ...extra }),
  launch: (_command: string, args: string[], _cwd?: string, env?: NodeJS.ProcessEnv) => {
    fixture.args = args
    return spawn(process.execPath, ['-e', fixture.script], { stdio: 'pipe', env })
  },
  terminateProcessTree: async (child: ReturnType<typeof spawn>) => {
    child.kill()
  },
  finalizeOwnedChild: async () => {},
}))
import { ClaudeAdapter } from '../src/runtime/adapters/claude'

const context: AgentContext = {
  cwd: '/tmp',
  session: {
    id: 'claude-app',
    projectId: 'project',
    nativeId: 'native-existing',
    provider: 'claude',
    title: 'Test',
    status: 'idle',
    archived: false,
    createdAt: 0,
    updatedAt: 0,
  },
}

describe('official Claude SDK through the user CLI process', () => {
  it('uses SDK controls for approval/question, resumes native sessions and streams text', async () => {
    fixture.script = `
      const rl=require('readline').createInterface({input:process.stdin});
      const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
      rl.on('line',line=>{const m=JSON.parse(line);
        if(m.type==='control_request'&&m.request.subtype==='initialize')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{commands:[],agents:[],output_style:'default',available_output_styles:[],models:[],account:{}}}});
        if(m.type==='control_request'&&m.request.subtype==='interrupt')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});
        if(m.type==='user'){
          if(m.message.content[1]?.type!=='image'||m.message.content[1].source.type!=='base64')process.exit(10);
          send({type:'system',subtype:'init',session_id:'native-existing',uuid:'init'});
          send({type:'control_request',request_id:'approval-1',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'echo hello'},tool_use_id:'tool-1'}});
        }
        if(m.type==='control_response'&&m.response.request_id==='approval-1'){
          if(m.response.response.behavior!=='allow')process.exit(8);
          send({type:'control_request',request_id:'question-1',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',input:{questions:[{question:'Format?',header:'Format',options:[{label:'JSON',description:'structured'}],multiSelect:false}]},tool_use_id:'tool-2'}});
        }
        if(m.type==='control_response'&&m.response.request_id==='question-1'){
          if(m.response.response.updatedInput.answers['Format?']!=='JSON')process.exit(9);
          send({type:'stream_event',session_id:'native-existing',event:{type:'message_start',message:{id:'answer'}}});
          send({type:'stream_event',session_id:'native-existing',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'你好'}}});
          send({type:'assistant',session_id:'native-existing',message:{id:'answer',content:[{type:'text',text:'你好'}]}});
          send({type:'result',subtype:'success',is_error:false,session_id:'native-existing',result:'你好',usage:{input_tokens:5,output_tokens:2},total_cost_usd:0.01});
        }
      });
    `
    const events: AgentEvent[] = []
    const adapter = new ClaudeAdapter((event) => {
      events.push(event)
      if (event.kind === 'approval')
        void adapter.respond(event.sessionId, event.requestId!, { decision: 'allow' })
      if (event.kind === 'question')
        void adapter.respond(event.sessionId, event.requestId!, { answers: { 0: ['JSON'] } })
    })
    try {
      await adapter.send(
        {
          ...context,
          input: {
            text: 'Hello',
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
        'Hello',
        'app-turn',
      )
      await vi.waitFor(() => expect(events.some((event) => event.kind === 'done')).toBe(true), {
        timeout: 5000,
      })
      expect(events.filter((event) => event.kind === 'error')).toEqual([])
      expect(events.filter((event) => event.kind === 'text')).toHaveLength(1)
      expect(events.find((event) => event.kind === 'text')).toMatchObject({
        itemId: 'answer:0',
        delta: true,
        text: '你好',
      })
      expect(events.filter((event) => event.kind === 'session')).toHaveLength(1)
      expect(events.find((event) => event.kind === 'usage')).toMatchObject({
        tokens: 7,
        cost: 0.01,
      })
      expect(fixture.args.join(' ')).toContain('--resume=native-existing')
      expect(fixture.args.join(' ')).toContain('user,project,local')
      expect(fixture.args.join(' ')).toContain('stdio')
    } finally {
      await adapter.close()
    }
  })
})
