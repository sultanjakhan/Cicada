"""Independent local stdio MCPs; route through running application authorities only.

No database writes, process launch of an AI, inference fees or guessed model usage.
The native operation_id and run sequence survive ambiguous transport failures.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

class NativeTaskError(RuntimeError):
    def __init__(self,value):
        self.value=value
        super().__init__(value.get('code',value.get('error','task_command_failed')))

MAX_FRAME = 16000


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError('duplicate field')
        result[key] = value
    return result


def parse(raw):
    return json.loads(raw, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('invalid number')))


def sid():
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    token = wintypes.HANDLE()
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)): raise OSError('current user unavailable')
    try:
        needed = wintypes.DWORD()
        advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))
        if not 0 < needed.value <= 65536: raise ValueError('identity size')
        buffer = ctypes.create_string_buffer(needed.value)
        if not advapi.GetTokenInformation(token, 1, buffer, len(buffer), ctypes.byref(needed)): raise OSError('identity unavailable')
        pointer = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0]
        text = ctypes.c_void_p()
        if not advapi.ConvertSidToStringSidW(pointer, ctypes.byref(text)): raise OSError('identity unavailable')
        try: return ctypes.wstring_at(text)
        finally: kernel.LocalFree(text)
    finally: kernel.CloseHandle(token)


def pipe_name(app, profile):
    prefix = 'CicadaAgent' if app == 'cicada' else 'AgentCityAgent'
    path = os.path.abspath(profile)
    # Profile paths are canonical configured host input, never a tool argument.
    if app == 'cicada': path = str(Path(path).resolve(strict=True))
    return prefix + '-' + hashlib.sha256((sid() + '\n' + path.upper()).encode()).hexdigest()[:32]


class Bridge:
    def __init__(self, app, profile, client):
        self.name = pipe_name(app, profile)
        self.client = str(Path(client).resolve(strict=True))

    def call(self, value):
        raw = json.dumps(value, ensure_ascii=False, allow_nan=False).encode() + b'\n'
        if len(raw) >= MAX_FRAME: raise ValueError('request too large')
        flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
        response = subprocess.run([self.client, self.name], input=raw, capture_output=True, timeout=45, **flags)
        if len(response.stdout) > 1024 * 1024: raise ValueError('response too large')
        result = parse(response.stdout)
        if not result.get('ok'):
            raise NativeTaskError(result)
        result = result['result']
        if isinstance(result, dict) and result.get('isError'):
            raise NativeTaskError(result)
        return result


def schema(properties, required):
    return {'type':'object', 'properties':properties, 'required':required, 'additionalProperties':False}


TEXT = {'type':'string'}
TASK_COMMANDS = [
    'snapshot', 'get', 'operation', 'share', 'patch', 'comment',
    'submit_result', 'review', 'acknowledge'
]
SERVER_INSTRUCTIONS = ('Use Cicada as the task authority. For authorized work, read and reuse the exact task UUID and current revision; preserve configured process stages. Report observed runs, submit immutable results for human review, and never auto-accept. Reuse the identical operationId and payload after an unknown outcome; re-read on revision conflict.')
REPORT = schema({
    'runId':{'type':'string','minLength':8,'maxLength':100,'pattern':'^[A-Za-z0-9_-]+$'},
    'sequence':{'type':'integer','minimum':1,'maximum':1000000000},
    'taskKey':{'type':['string','null']},
    'agent':{'type':'string','enum':['codex','claude','other','agent-city']},
    'model':{'type':['string','null'],'maxLength':200},
    'provider':{'type':['string','null'],'maxLength':80},
    'stage':{'type':['string','null'],'maxLength':120},
    'status':{'type':'string','enum':['running','waiting','done','error','cancelled']},
    'skillIds':{'type':'array','maxItems':40,'items':{'type':'string','pattern':'^skill-[0-9a-f]{24}$'}},
    'mcpCalls':{'type':['array','null'],'maxItems':30,'items':schema({'server':TEXT,'tool':TEXT,'calls':{'type':'integer','minimum':0,'maximum':1000000000000}},['server','tool','calls'])},
    'inputTokens':{'type':['integer','null'],'minimum':0,'maximum':1000000000000},
    'outputTokens':{'type':['integer','null'],'minimum':0,'maximum':1000000000000}
},['runId','sequence','taskKey','agent','model','provider','stage','status','skillIds','mcpCalls','inputTokens','outputTokens'])
REPORT['description'] = 'Observed cumulative snapshot. Unknown model/provider/usage are null. No task text, result text or tool arguments.'
IDENTITY = {'type':'string', 'minLength':8, 'maxLength':100}


def tools_for(app):
    if app == 'cicada':
        return [
            {'name':'cicada_list_tasks','description':'Read-only list of up to 100 personal native tasks; no corporate records.', 'inputSchema':schema({},[])},
            {'name':'cicada_read_task','description':'Read-only snapshot of one exact personal native task UUID.', 'inputSchema':schema({'taskId':TEXT},['taskId'])},
            {'name':'cicada_begin_ai_work','description':'Register work the user has authorized and the calling AI is already performing. Reuse an existing task UUID when known; a null taskId may create one only within that authorization. Atomically writes a binding and observed running report; it does not launch a model, start a human timer, or complete the task. Keep operationId after timeout.',
             'inputSchema':schema({'operationId':IDENTITY,'title':TEXT,'content':TEXT,'taskId':{'type':['string','null']},'expectedVersion':{'type':['integer','null']},'projects':{'type':'array','items':TEXT},'report':REPORT},['operationId','title','content','taskId','expectedVersion','projects','report'])},
            {'name':'cicada_report_ai_work','description':'Report observed progress for the exact task and run. It never invents telemetry or completes the task; native completion remains a separate user decision. Reuse the original operationId and payload after an unknown outcome.',
             'inputSchema':schema({'operationId':IDENTITY,'taskId':TEXT,'expectedVersion':{'type':'integer'},'report':REPORT},['operationId','taskId','expectedVersion','report'])},
            {'name':'cicada_task_command','description':'Send one revisioned native Cicada task command using the exact task UUID. Read commands are snapshot, get, operation; mutations include share, patch (stage/content), comment, submit_result, review and acknowledge. Reuse the identical operationId and payload after an unknown outcome. Review/acceptance never happens automatically.',
             'inputSchema':schema({'operationId':IDENTITY,'command':{'type':'string','enum':TASK_COMMANDS},'arguments':{'type':'object','description':'Native command arguments. The Cicada boundary validates exact fields, task UUID and expectedVersion.'}},['operationId','command','arguments'])}]
    return [
        {'name':'agent_city_read_shared_tasks','description':'Read confirmed shared tasks, pending edits, conflicts and connection freshness.','inputSchema':schema({},[])},
        {'name':'agent_city_sync_tasks','description':'Exchange the configured durable queue and projection, without any window activation.','inputSchema':schema({},[])},
        {'name':'agent_city_queue_task_change','description':'Queue an explicit revisioned task/result/review mutation. Pending is not running or confirmed.','inputSchema':schema({'operationId':IDENTITY,'command':{'type':'string'},'arguments':{'type':'object'}},['operationId','command','arguments'])},
        {'name':'agent_city_context','description':'Read current configured global/repository rules and inventory. Does not install anything.', 'inputSchema':schema({'cwd':TEXT},['cwd'])},
        {'name':'agent_city_dashboard','description':'Read Cicada tasks and reported AI executions from the selected configured source.', 'inputSchema':schema({},[])},
        {'name':'agent_city_inventory','description':'Read enumerated skills, models or providers. Catalogue membership does not prove availability.', 'inputSchema':schema({'kind':{'type':'string','enum':['skill-inventory','models','providers']}},['kind'])},
        {'name':'agent_city_report_run','description':'Record an observed executor report with the exact native Cicada binding. No task completion or model launch.', 'inputSchema':schema({'binding':{'type':'object'},'report':REPORT},['binding','report'])},
        {'name':'agent_city_report_skill_use','description':'Record one actual skill use; eventId deduplicates retries.', 'inputSchema':schema({'id':TEXT,'agent':{'type':'string','enum':['codex','claude','other']},'eventId':IDENTITY},['id','agent','eventId'])}]


def invoke(app, bridge, name, args):
    definition = next((item for item in tools_for(app) if item['name'] == name), None)
    if not definition or type(args) is not dict: raise ValueError('unsupported tool')
    contract = definition['inputSchema']
    if set(args) != set(contract['properties']): raise ValueError('unsupported tool fields')
    if name == 'cicada_task_command':
        if args.get('command') not in TASK_COMMANDS or type(args.get('arguments')) is not dict:
            raise ValueError('unsupported task command')
    if app == 'cicada':
        body = copy.deepcopy(args)
        op = body.pop('operationId', str(uuid.uuid4()))
        if name == 'cicada_task_command':
            return bridge.call({'version':1,'operation_id':op,'action':'task-command',
                                'body':{'command':body['command'],'arguments':body['arguments']}})
        action = {'cicada_list_tasks':'list','cicada_read_task':'get','cicada_begin_ai_work':'begin','cicada_report_ai_work':'report'}[name]
        return bridge.call({'version':1,'operation_id':op,'action':action,'body':body})
    from urllib.parse import urlencode
    if name == 'agent_city_read_shared_tasks': path = '/api/task-sync'; body = None
    elif name == 'agent_city_sync_tasks': path = '/api/task-sync/exchange'; body = {}
    elif name == 'agent_city_queue_task_change': path = '/api/task-sync/queue'; body = dict(args,version=1)
    elif name == 'agent_city_context': path = '/api/v1/context?' + urlencode(args); body = None
    elif name == 'agent_city_dashboard': path = '/api/dashboard'; body = None
    elif name == 'agent_city_inventory': path = '/api/v1/' + args['kind']; body = None
    elif name == 'agent_city_report_run': path = '/api/agent/report'; body = args
    else: path = '/api/skill-activity'; body = dict(args, kind='use')
    return bridge.call({'method':'GET' if body is None else 'POST','path':path,'body':body})


def serve(app, bridge):
    while True:
        raw = sys.stdin.buffer.readline(64 * 1024 + 1)
        if not raw: break
        if len(raw) > 64 * 1024: return
        ident = None
        try:
            if len(raw) > 64 * 1024: raise ValueError('MCP frame too large')
            request = parse(raw)
            ident = request.get('id')
            method = request['method']; params = request.get('params', {})
            if method.startswith('notifications/'): continue
            if method == 'initialize':
                result = {'protocolVersion':params.get('protocolVersion','2025-03-26'),'capabilities':{'tools':{}},'serverInfo':{'name':app+'-local-authority','version':'1.0.0'}}
                if app == 'cicada': result['instructions'] = SERVER_INSTRUCTIONS
            elif method == 'ping': result = {}
            elif method == 'tools/list': result = {'tools':tools_for(app)}
            elif method == 'tools/call':
                try:
                    value = invoke(app, bridge, params['name'], params.get('arguments',{}))
                    result = {'content':[{'type':'text','text':json.dumps(value,ensure_ascii=False)}],'structuredContent':value,'isError':False}
                except Exception as error:
                    # Domain errors are bounded categories, never request contents.
                    label = str(error) if isinstance(error,(ValueError,RuntimeError)) and len(str(error)) < 120 else 'application_unavailable_or_outcome_unknown'
                    result = {'content':[{'type':'text','text':label}],'isError':True}
            else: raise ValueError('unsupported MCP method')
            response = {'jsonrpc':'2.0','id':ident,'result':result}
        except Exception:
            response = {'jsonrpc':'2.0','id':ident,'error':{'code':-32600,'message':'Invalid request'}}
        sys.stdout.write(json.dumps(response,ensure_ascii=False,allow_nan=False)+'\n'); sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--app',choices=['cicada','agent-city'],required=True)
    parser.add_argument('--profile',required=True)
    parser.add_argument('--client',required=True)
    parser.add_argument('--call',help='one MCP tool name; arguments from stdin')
    args = parser.parse_args()
    bridge = Bridge(args.app,args.profile,args.client)
    if args.call:
        raw = sys.stdin.buffer.read(64*1024+1)
        result = invoke(args.app,bridge,args.call,parse(raw))
        print(json.dumps(result,ensure_ascii=False,allow_nan=False))
    else: serve(args.app,bridge)


if __name__ == '__main__': main()
