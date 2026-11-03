import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../src/shared/runtime'
import type { AgentEvent } from '../src/shared/types'

const fixture = vi.hoisted(() => ({
  script: '',
  launches: 0,
  children: [] as import('node:child_process').ChildProcessWithoutNullStreams[],
}))
vi.mock('../src/runtime/process', () => ({
  resolveCommand: async () => process.execPath,
  launch: (_command: string, args: string[], _cwd?: string, env?: NodeJS.ProcessEnv) => {
    fixture.launches++
    const port = args[args.indexOf('--port') + 1]
    const child = spawn(
      process.execPath,
      ['-e', fixture.script, '--', port, String(fixture.launches)],
      {
        stdio: 'pipe',
        env: { ...process.env, ...env },
      },
    )
    fixture.children.push(child)
    return child
  },
  terminateProcessTree: async (child: ReturnType<typeof spawn>) => {
    child.kill()
  },
  finalizeOwnedChild: async () => {},
}))
import { OpenCodeAdapter } from '../src/runtime/adapters/opencode'

const adapters: OpenCodeAdapter[] = []
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()))
  fixture.children = []
})
const context = (id: string): AgentContext => ({
  cwd: '/tmp',
  session: {
    id,
    projectId: 'project',
    provider: 'opencode',
    title: 'Test',
    model: 'test/model',
    status: 'idle',
    archived: false,
    createdAt: 0,
    updatedAt: 0,
  },
})

describe('OpenCode stable HTTP/SSE transport', () => {
  it('retains failed permission replies and failed stops until the native server acknowledges them', async () => {
    fixture.script = `
      const http=require('http');let replies=0,aborts=0;const streams=[];
      const auth='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
      const event=(type,properties)=>streams.forEach(s=>s.write('data: '+JSON.stringify({type,properties})+'\\n\\n'));
      http.createServer((req,res)=>{
        if(req.headers.authorization!==auth){res.writeHead(401);res.end();return}
        const path=new URL(req.url,'http://localhost').pathname;
        const json=v=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(v))};
        if(path==='/event'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': connected\\n\\n');streams.push(res);return}
        req.resume();req.on('end',()=>{
          if(path==='/global/health'){json({healthy:true,version:'1.19.5'});return}
          if(path==='/session'){json({id:'native-failure'});return}
          if(path.endsWith('/prompt_async')){res.writeHead(204);res.end();event('session.status',{sessionID:'native-failure',status:{type:'busy'}});event('permission.asked',{id:'permission',sessionID:'native-failure',permission:'bash',patterns:['echo'],metadata:{}});return}
          if(path==='/permission/permission/reply'){if(++replies===1){res.writeHead(503);res.end('Try again');return}json(true);return}
          if(path.endsWith('/abort')){if(++aborts===1){res.writeHead(500);res.end('Still busy');return}json(true);return}
          if(path.endsWith('/message')){json([]);return}
          res.writeHead(404);res.end();
        });
      }).listen(Number(process.argv[1]),'127.0.0.1');
    `
    const events: AgentEvent[] = []
    const adapter = new OpenCodeAdapter((event) => events.push(event))
    adapters.push(adapter)
    await adapter.send(context('failure'), 'Work', 'failure-turn')
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'approval')).toBe(true))
    await expect(adapter.respond('failure', 'permission', { decision: 'once' })).rejects.toThrow(
      '503',
    )
    expect(
      events.some((event) => event.kind === 'requestResolved' && event.resolution === 'approved'),
    ).toBe(false)
    await adapter.respond('failure', 'permission', { decision: 'once' })
    expect(events.findLast((event) => event.kind === 'requestResolved')).toMatchObject({
      resolution: 'approved',
    })
    await expect(adapter.interrupt('failure')).rejects.toThrow('500')
    expect(events.at(-1)).toMatchObject({ kind: 'status', status: 'stop_failed' })
    expect(events.some((event) => event.kind === 'done')).toBe(false)
    await expect(adapter.send(context('failure'), 'Other work', 'next')).rejects.toThrow(
      'already running',
    )
    await adapter.interrupt('failure')
    expect(events.at(-1)).toMatchObject({ kind: 'done', status: 'interrupted' })
  })
  it('authenticates a project server, multiplexes sessions, and answers permissions/questions', async () => {
    fixture.launches = 0
    fixture.script = `
      const http=require('http');let count=0;const sessions=new Map(), streams=[];
      const auth='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
      function event(type,properties){const data=Buffer.from('data: '+JSON.stringify({type,properties})+'\\n\\n');for(const stream of streams){for(const byte of data)stream.write(Buffer.from([byte]))}}
      const server=http.createServer((req,res)=>{
        if(req.headers.authorization!==auth){res.writeHead(401);res.end();return}
        const url=new URL(req.url,'http://localhost');const path=url.pathname;
        if(path==='/event'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': connected\\n\\n');streams.push(res);req.on('close',()=>streams.splice(streams.indexOf(res),1));return}
        let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{
          let body=raw?JSON.parse(raw):{};const json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value))};
          if(path==='/global/health'){json({healthy:true,version:'1.19.5'});return}
          if(path==='/provider'){json({all:[{id:'test',name:'Test',models:{model:{name:'Test model'}}}],connected:['test']});return}
          if(path==='/session'&&req.method==='POST'){const id='native-'+(++count);sessions.set(id,{messages:[]});json({id});return}
          const match=path.match(/^\\/session\\/([^/]+)(?:\\/(.*))?$/);
          if(match){const id=match[1],action=match[2],session=sessions.get(id);
            if(!session){res.writeHead(404);res.end();return}
            if(!action){json({id});return}
            if(action==='message'){json(session.messages);return}
            if(action==='abort'){event('session.status',{sessionID:id,status:{type:'idle'}});json(true);return}
            if(action==='prompt_async'){
              if(body.model.providerID!=='test'){res.writeHead(400);res.end();return}
              if(body.parts[1]?.type!=='file'||body.parts[1].mime!=='image/png'){res.writeHead(400);res.end();return}
              res.writeHead(204);res.end();
              event('session.status',{sessionID:id,status:{type:'idle'}});
              setTimeout(()=>{event('session.status',{sessionID:id,status:{type:'busy'}});event('message.updated',{info:{id:'user-'+id,sessionID:id,role:'user'}});event('message.part.updated',{part:{id:'echo-'+id,sessionID:id,messageID:'user-'+id,type:'text',text:'USER ECHO'}});event('permission.asked',{id:'p-'+id,sessionID:id,permission:'bash',patterns:['echo'],metadata:{}})},10);return
            }
          }
          if(path.startsWith('/permission/')){
            if(body.reply!=='once'){res.writeHead(400);res.end();return}
            const id=path.split('/')[2].slice(2);json(true);event('question.asked',{id:'q-'+id,sessionID:id,questions:[{question:'Format?',options:[{label:'JSON'}],multiple:false}]});return
          }
          if(path.startsWith('/question/')){
            const id=path.split('/')[2].slice(2);if(body.answers[0][0]!=='JSON'){res.writeHead(400);res.end();return}json(true);
            const messageID='answer-'+id;const part={id:'part-'+id,sessionID:id,messageID,type:'text',text:'你好'};
            sessions.get(id).messages.push({info:{id:messageID,role:'assistant'},parts:[part]});
            event('message.updated',{info:{id:messageID,sessionID:id,role:'assistant'}});
            event('message.part.delta',{sessionID:id,messageID,partID:part.id,field:'text',delta:'你好'});
            event('message.part.updated',{part});event('session.status',{sessionID:id,status:{type:'idle'}});return
          }
          res.writeHead(404);res.end();
        })
      });server.listen(Number(process.argv[1]),'127.0.0.1');
    `
    const events: AgentEvent[] = []
    const adapter = new OpenCodeAdapter((event) => {
      events.push(event)
      if (event.kind === 'approval')
        void adapter.respond(event.sessionId, event.requestId!, { decision: 'once' })
      if (event.kind === 'question')
        void adapter.respond(event.sessionId, event.requestId!, { answers: { 0: ['JSON'] } })
    })
    adapters.push(adapter)
    expect(await adapter.models(process.execPath, '/tmp')).toEqual([
      { id: 'test/model', name: 'Test / Test model' },
    ])
    await vi.waitFor(() => expect(fixture.children[0].signalCode).not.toBeNull())
    await Promise.all([
      ...['app-1', 'app-2'].map((id, index) =>
        adapter.send(
          {
            ...context(id),
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
          `turn-${index + 1}`,
        ),
      ),
    ])
    // A discovery that sees a send's reserved server must leave it alive.
    expect(await adapter.models(process.execPath, '/tmp')).toEqual([
      { id: 'test/model', name: 'Test / Test model' },
    ])
    await vi.waitFor(
      () => expect(events.filter((event) => event.kind === 'done')).toHaveLength(2),
      { timeout: 5000 },
    )
    expect(fixture.launches).toBe(2)
    expect(fixture.children[1].signalCode).toBeNull()
    expect(events.filter((event) => event.kind === 'error')).toEqual([])
    expect(
      events.filter((event) => event.kind === 'text').every((event) => event.text === '你好'),
    ).toBe(true)
    for (const id of ['app-1', 'app-2']) {
      expect(
        events.some(
          (event) => event.sessionId === id && event.kind === 'session' && event.nativeId,
        ),
      ).toBe(true)
      expect(
        events.some(
          (event) => event.sessionId === id && event.kind === 'text' && event.delta && event.itemId,
        ),
      ).toBe(true)
    }
  })
  it('keeps a concurrent send alive when an independent discovery lease finishes', async () => {
    fixture.launches = 0
    fixture.script = `
      const http=require('http');let stream;
      const auth='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
      const event=(type,properties)=>stream?.write('data: '+JSON.stringify({type,properties})+'\\n\\n');
      const id='native-'+process.pid, messageID='message-'+process.pid;
      http.createServer((req,res)=>{
        if(req.headers.authorization!==auth){res.writeHead(401);res.end();return}
        const path=new URL(req.url,'http://localhost').pathname;
        const json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value))};
        if(path==='/global/health'){json({healthy:true,version:'1.19.5'});return}
        if(path==='/event'){stream=res;res.writeHead(200,{'content-type':'text/event-stream'});res.write(':ready\\n\\n');return}
        if(path==='/provider'){setTimeout(()=>json({all:[],connected:[]}),80);return}
        req.resume();req.on('end',()=>{
          if(path==='/session'){json({id});return}
          if(path.endsWith('/prompt_async')){
            res.writeHead(204);res.end();event('session.status',{sessionID:id,status:{type:'busy'}});
            setTimeout(()=>{event('message.updated',{info:{id:messageID,sessionID:id,role:'assistant'}});event('message.part.delta',{sessionID:id,messageID,partID:'text',field:'text',delta:'alive'});event('session.status',{sessionID:id,status:{type:'idle'}})},180);return
          }
          if(path.endsWith('/message')){json([{info:{id:messageID,role:'assistant'},parts:[{id:'text',sessionID:id,messageID,type:'text',text:'alive'}]}]);return}
          json(true);
        });
      }).listen(Number(process.argv[1]),'127.0.0.1');
    `
    const events: AgentEvent[] = []
    const adapter = new OpenCodeAdapter((event) => events.push(event))
    adapters.push(adapter)
    // Probe starts first, so it cannot borrow the send's persistent cache entry.
    const probe = adapter.models(process.execPath, '/tmp')
    await adapter.send(context('parallel'), 'Hello', 'parallel-turn')
    expect(await probe).toEqual([])
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'done')).toBe(true), {
      timeout: 5000,
    })
    expect(fixture.launches).toBe(2)
    expect(events.filter((event) => event.kind === 'error')).toEqual([])
    expect(events.some((event) => event.kind === 'text' && event.text === 'alive')).toBe(true)
    await vi.waitFor(() =>
      expect(fixture.children.filter((child) => child.signalCode !== null)).toHaveLength(1),
    )
    expect(fixture.children.filter((child) => child.signalCode === null)).toHaveLength(1)
  })
  it('refuses an unauthenticated server and retries with fresh ports at most three times', async () => {
    fixture.launches = 0
    fixture.script = `require('http').createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({healthy:true,version:'1.19.5'}))}).listen(Number(process.argv[1]),'127.0.0.1');`
    const adapter = new OpenCodeAdapter(() => {})
    adapters.push(adapter)
    await expect(adapter.models(process.execPath, '/tmp')).rejects.toThrow('expected HTTP 401')
    expect(fixture.launches).toBe(3)
  })
  it('retries a real bind failure instead of keeping a dead project server', async () => {
    fixture.launches = 0
    fixture.script = `
      if(process.argv[2]==='1'){process.stderr.write('EADDRINUSE: address already in use');process.exit(1)}
      const auth='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
      require('http').createServer((req,res)=>{
        if(req.headers.authorization!==auth){res.writeHead(401);res.end();return}
        if(req.url.startsWith('/event')){res.writeHead(200,{'content-type':'text/event-stream'});res.write(':ready\\n\\n');return}
        res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.startsWith('/global/health')?{healthy:true,version:'1.19.5'}:{all:[],connected:[]}));
      }).listen(Number(process.argv[1]),'127.0.0.1');
    `
    const adapter = new OpenCodeAdapter(() => {})
    adapters.push(adapter)
    expect(await adapter.models(process.execPath, '/tmp')).toEqual([])
    expect(fixture.launches).toBe(2)
  })
})
