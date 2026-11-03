import {
  test as base,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import type { ProviderId } from '../../src/shared/types'

const requireModule = createRequire(resolve('package.json'))
const codexSource = String.raw`
const fs=require('node:fs'),crypto=require('node:crypto'),readline=require('node:readline');
if(process.argv.includes('--version')){console.log('codex-cli 0.151.0');process.exit(0)}
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');let threadId='',turnId='',timer;
const complete=text=>{send({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'answer-'+turnId,delta:text}});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}})};
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),p=m.params||{};
if(m.method==='initialize')send({id:m.id,result:{userAgent:'fixture'}});
if(m.method==='model/list')send({id:m.id,result:{data:[{id:'fixture-model',displayName:'Fixture model'}]}});
if(m.method==='thread/start'||m.method==='thread/resume'){threadId=p.threadId||crypto.randomUUID();send({id:m.id,result:{thread:{id:threadId}}})}
if(m.method==='turn/start'){turnId=crypto.randomUUID();send({id:m.id,result:{turn:{id:turnId}}});const text=p.input?.find(i=>i.type==='text')?.text||'';
if(text.includes('approval'))send({id:800,method:'item/commandExecution/requestApproval',params:{threadId,turnId,itemId:'tool',command:'printf fixture-approved',reason:'Fixture permission request',availableDecisions:['accept','decline']}});
else if(text.includes('question'))send({id:801,method:'item/tool/requestUserInput',params:{threadId,turnId,questions:[{id:'format',question:'选择输出格式',options:[{label:'JSON'},{label:'文本'}]}]}});
else if(text.includes('permission-profile'))send({id:802,method:'item/permissions/requestApproval',params:{threadId,turnId,reason:'Fixture permission profile request',permissions:{network:{enabled:true}}}});
else if(text.includes('long-output')){const output='BEGIN_LONG_OUTPUT\n'+'x'.repeat(90000)+'\nEND_LONG_OUTPUT';send({method:'item/started',params:{threadId,turnId,item:{id:'long-output-command',type:'commandExecution',command:'printf long-output',status:'inProgress'}}});for(let offset=0;offset<output.length;offset+=30000)send({method:'item/commandExecution/outputDelta',params:{threadId,turnId,itemId:'long-output-command',delta:output.slice(offset,offset+30000)}});send({method:'item/completed',params:{threadId,turnId,item:{id:'long-output-command',type:'commandExecution',command:'printf long-output',aggregatedOutput:output,status:'completed'}}});setTimeout(()=>complete('CODEX_LONG_OUTPUT_COMPLETE'),30)}
else if(text.includes('write-file long-running-review')){fs.writeFileSync('hello.ts','export const hello = "ISOLATED_CHANGE"\n');fs.appendFileSync(__filename+'.turns',turnId+'\n');timer=setInterval(()=>{},1000)}
else if(text.includes('long-running'))timer=setInterval(()=>{},1000);
else{if(text.includes('write-file'))fs.writeFileSync('hello.ts','export const hello = "ISOLATED_CHANGE"\n');setTimeout(()=>complete(text.includes('background')?'BACKGROUND_COMPLETED':'CODEX_TRANSPORT_OK 中文流式输出'),text.includes('background')?500:30)}}
if(m.id===800&&m.result)complete(m.result.decision==='accept'?'CODEX_APPROVED':'CODEX_DECLINED');
if(m.id===801&&m.result)complete(m.result.answers?.format?.answers?.[0]==='JSON'?'CODEX_ANSWERED_JSON':'CODEX_ANSWERED_OTHER');
if(m.id===802&&m.result)complete(m.result.permissions?.network?.enabled?'CODEX_PROFILE_'+m.result.scope.toUpperCase():'CODEX_PROFILE_DECLINED');
if(m.method==='turn/interrupt'){clearInterval(timer);send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'interrupted'}}})}
});process.stdin.on('end',()=>process.exit(0));
`
const claudeSource = String.raw`
const crypto=require('node:crypto'),readline=require('node:readline');
if(process.argv.includes('--version')){console.log('Claude Code 2.1.236');process.exit(0)}
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
const nativeId=(process.argv.find(a=>a.startsWith('--resume='))||'').slice(9)||crypto.randomUUID();let timer;
const complete=text=>{const id=crypto.randomUUID();send({type:'stream_event',session_id:nativeId,event:{type:'message_start',message:{id}}});send({type:'stream_event',session_id:nativeId,event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}});send({type:'assistant',session_id:nativeId,message:{id,content:[{type:'text',text}]}});send({type:'result',subtype:'success',is_error:false,session_id:nativeId,result:text,usage:{input_tokens:5,output_tokens:2},total_cost_usd:0})};
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.type==='control_request'&&m.request.subtype==='initialize')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{commands:[],agents:[],output_style:'default',available_output_styles:[],models:[{value:'fixture-model',displayName:'Fixture model',description:'Isolated CLI fixture'}],account:{}}}});
if(m.type==='control_request'&&m.request.subtype==='interrupt'){clearInterval(timer);send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}})}
if(m.type==='user'){send({type:'system',subtype:'init',session_id:nativeId,uuid:crypto.randomUUID()});const text=typeof m.message.content==='string'?m.message.content:m.message.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
if(text.includes('approval'))send({type:'control_request',request_id:'approval',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'printf fixture-approved'},tool_use_id:'tool'}});
else if(text.includes('long-running'))timer=setInterval(()=>{},1000);
else setTimeout(()=>complete('CLAUDE_TRANSPORT_OK 中文流式输出'),30)}
if(m.type==='control_response'&&m.response.request_id==='approval')complete(m.response.response.behavior==='allow'?'CLAUDE_APPROVED':'CLAUDE_DECLINED');
});process.stdin.on('end',()=>process.exit(0));
`
const opencodeSource = String.raw`
const http=require('node:http'),crypto=require('node:crypto');
if(process.argv.includes('--version')){console.log('1.19.5');process.exit(0)}
const port=Number(process.argv[process.argv.indexOf('--port')+1]);const streams=new Set(),sessions=new Map();
const auth='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
const event=(type,properties)=>{for(const stream of streams)stream.write('data: '+JSON.stringify({type,properties})+'\n\n')};
const complete=(id,text)=>{const messageID=crypto.randomUUID(),part={id:crypto.randomUUID(),sessionID:id,messageID,type:'text',text};sessions.get(id).messages.push({info:{id:messageID,role:'assistant'},parts:[part]});event('message.updated',{info:{id:messageID,sessionID:id,role:'assistant'}});event('message.part.delta',{sessionID:id,messageID,partID:part.id,field:'text',delta:text});event('message.part.updated',{part});event('session.status',{sessionID:id,status:{type:'idle'}})};
http.createServer((req,res)=>{if(req.headers.authorization!==auth){res.writeHead(401);res.end();return}const url=new URL(req.url,'http://localhost'),path=url.pathname;const json=v=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(v))};
if(path==='/event'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': connected\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return}
let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{const body=raw?JSON.parse(raw):{};
if(path==='/global/health'){json({healthy:true,version:'1.19.5'});return}
if(path==='/provider'){json({all:[{id:'fixture',name:'Fixture',models:{model:{name:'Fixture model'}}}],connected:['fixture']});return}
if(path==='/session'&&req.method==='POST'){const id=crypto.randomUUID();sessions.set(id,{messages:[]});json({id});return}
const match=path.match(/^\/session\/([^/]+)(?:\/(.*))?$/);if(match){const id=match[1],action=match[2];if(!sessions.has(id)){res.writeHead(404);res.end();return}
if(!action){json({id});return}if(action==='message'){json(sessions.get(id).messages);return}if(action==='abort'){json(true);event('session.status',{sessionID:id,status:{type:'idle'}});return}
if(action==='prompt_async'){res.writeHead(204);res.end();event('session.status',{sessionID:id,status:{type:'busy'}});const text=body.parts.filter(p=>p.type==='text').map(p=>p.text).join('\n');if(text.includes('approval'))event('permission.asked',{id:'approval-'+id,sessionID:id,permission:'bash',patterns:['printf fixture-approved'],metadata:{}});else if(!text.includes('long-running'))setTimeout(()=>complete(id,'OPENCODE_TRANSPORT_OK 中文流式输出'),30);return}}
if(path.startsWith('/permission/')){const id=path.split('/')[2].slice(9);json(true);complete(id,body.reply==='reject'?'OPENCODE_DECLINED':'OPENCODE_APPROVED');return}
res.writeHead(404);res.end();});}).listen(port,'127.0.0.1');
`

export interface Desktop {
  app: ElectronApplication
  page: Page
  location: string
  projectPath: string
  cliPaths: Record<ProviderId, string>
  restart(): Promise<{
    app: ElectronApplication
    page: Page
    launchStartedAt: number
    launchTimings: { mainConnectedMs: number; firstWindowMs: number; domReadyMs: number }
  }>
}
export const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({}, use) => {
    const location = await mkdtemp(join(tmpdir(), 'coding-hub-desktop-'))
    const projectPath = join(location, '中文 project'),
      data = join(location, 'data')
    await mkdir(data, { recursive: true })
    await mkdir(join(location, 'zsh'), { recursive: true })
    execFileSync('git', ['init', '-b', 'main', projectPath], { stdio: 'ignore' })
    for (const [key, value] of [
      ['user.name', 'Desktop test'],
      ['user.email', 'test@example.invalid'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', join(location, 'empty-hooks')],
    ])
      execFileSync('git', ['config', key, value], { cwd: projectPath })
    await writeFile(join(projectPath, 'hello.ts'), 'export const hello = "world"\n')
    execFileSync('git', ['add', 'hello.ts'], { cwd: projectPath })
    execFileSync('git', ['commit', '-m', 'test: initial fixture'], {
      cwd: projectPath,
      stdio: 'ignore',
    })
    const cliPaths = {} as Record<ProviderId, string>
    for (const [provider, source] of Object.entries({
      codex: codexSource,
      claude: claudeSource,
      opencode: opencodeSource,
    }) as [ProviderId, string][]) {
      const script = join(location, `${provider}.cjs`)
      await writeFile(script, source)
      const wrapper = join(location, `${provider}.${process.platform === 'win32' ? 'cmd' : 'sh'}`)
      await writeFile(
        wrapper,
        process.platform === 'win32'
          ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
          : `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${script.replace(/'/g, "'\\''")}' "$@"\n`,
      )
      if (process.platform !== 'win32') await chmod(wrapper, 0o755)
      cliPaths[provider] = wrapper
    }
    // Seed real legacy storage, then let the application run its actual migration.
    // This prevents initial discovery from touching an installed/account-backed CLI.
    execFileSync(
      requireModule('electron'),
      [
        '-e',
        `const D=require('better-sqlite3');const db=new D(process.argv[1]);db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,data TEXT NOT NULL);CREATE TABLE sessions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);CREATE TABLE events(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),stream_key TEXT,ordinal INTEGER NOT NULL,data TEXT NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,data TEXT NOT NULL);PRAGMA user_version=1;');db.prepare("INSERT INTO settings VALUES('app',?)").run(process.argv[2]);db.close()`,
        join(data, 'coding-hub.db'),
        JSON.stringify({ theme: 'light', cliPaths }),
      ],
      { cwd: resolve('.'), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
    )
    const env = Object.fromEntries(
      Object.entries({
        ...process.env,
        CODING_HUB_USER_DATA: data,
        ZDOTDIR: join(location, 'zsh'),
      }).filter(([, value]) => value !== undefined),
    ) as Record<string, string>
    delete env.ELECTRON_RUN_AS_NODE
    for (const key of Object.keys(env))
      if (
        /(?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|server[_-]?password|^GH_TOKEN$|^GITHUB_TOKEN$)/i.test(
          key,
        )
      )
        delete env[key]
    const executablePath = process.env.CODING_HUB_PACKAGED_APP
    let current: ElectronApplication | undefined
    const errors: string[] = []
    const launch = async () => {
      const launchStartedAt = performance.now()
      const app = await electron.launch({
        executablePath,
        args: executablePath ? [] : [resolve('.')],
        env,
      })
      const mainConnectedMs = performance.now() - launchStartedAt
      current = app
      app.once('close', () => {
        if (current === app) current = undefined
      })
      const page = await app.firstWindow()
      const firstWindowMs = performance.now() - launchStartedAt
      page.on('pageerror', (error) => errors.push(error.message))
      await page.waitForLoadState('domcontentloaded')
      const domReadyMs = performance.now() - launchStartedAt
      return {
        app,
        page,
        launchStartedAt,
        launchTimings: { mainConnectedMs, firstWindowMs, domReadyMs },
      }
    }
    const initial = await launch()
    const desktop: Desktop = {
      app: initial.app,
      page: initial.page,
      location,
      projectPath,
      cliPaths,
      restart: async () => {
        await current?.close()
        current = undefined
        const result = await launch()
        desktop.app = result.app
        desktop.page = result.page
        return result
      },
    }
    try {
      await use(desktop)
    } finally {
      await current?.close()
      await rm(location, { recursive: true, force: true })
      expect(errors).toEqual([])
    }
  },
})
export { expect }
export async function openTrustedProject({ app, page, projectPath }: Desktop) {
  await expect(page.getByRole('heading', { name: '打开项目', exact: true })).toBeVisible()
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [selected],
    })) as typeof dialog.showOpenDialog
  }, projectPath)
  await page.getByRole('button', { name: '打开项目', exact: true }).first().click()
  await expect(page.getByRole('button', { name: '信任此项目', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '信任此项目', exact: true }).click()
  await expect(page.getByRole('button', { name: '信任此项目', exact: true })).toHaveCount(0)
}
export async function createSession(
  page: Page,
  provider: ProviderId,
  workspace: 'shared' | 'isolated' = 'shared',
) {
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '新建会话', exact: true })
  const name = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' }[provider]
  await dialog
    .getByRole('button')
    .filter({ has: page.getByText(name, { exact: true }) })
    .click()
  await dialog.locator('#session-workspace').selectOption(workspace)
  await dialog.getByRole('button', { name: '开始会话', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeVisible()
  return page.evaluate(async () => {
    const state = await window.hub.bootstrap()
    return state.sessions.find((s) => s.id === state.settings.lastSessionId)!
  })
}
export async function sendMessage(page: Page, text: string) {
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill(text)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
}
