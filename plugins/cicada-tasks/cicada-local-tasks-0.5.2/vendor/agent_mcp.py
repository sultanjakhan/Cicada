"""Independent local stdio MCPs; route through running application authorities only.

No database writes, process launch of an AI, inference fees or guessed model usage.
The native operation_id and run sequence survive ambiguous transport failures.
"""
import argparse
import copy
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import uuid

class NativeTaskError(RuntimeError):
    def __init__(self,value):
        self.value=value
        super().__init__(value.get('code',value.get('error','task_command_failed')))

MAX_FRAME = 64 * 1024


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
    def __init__(self, app, profile, client=None, socket_directory=None):
        self.mac = None
        if sys.platform == 'darwin':
            if app != 'cicada' or client is not None or socket_directory is None:
                raise ValueError('explicit macOS Cicada endpoint required')
            from mac_transport import MacTransport
            self.mac = MacTransport(profile, socket_directory)
            return
        if socket_directory is not None:
            raise ValueError('macOS socket transport unavailable')
        self.name = pipe_name(app, profile)
        self.client = str(Path(client).resolve(strict=True))

    def call(self, value):
        raw = json.dumps(value, ensure_ascii=False, allow_nan=False).encode() + b'\n'
        if len(raw) > MAX_FRAME: raise ValueError('request too large')
        if self.mac is not None:
            try:
                result = parse(self.mac.exchange(raw))
                if type(result) is not dict or type(result.get('ok')) is not bool:
                    raise ValueError('invalid authority reply')
                if not result['ok']: raise NativeTaskError(result)
                result = result['result']
                if isinstance(result, dict) and result.get('isError'):
                    raise NativeTaskError(result)
                return result
            except NativeTaskError:
                raise
            except Exception as error:
                raise RuntimeError('application_unavailable_or_outcome_unknown') from error
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

# Narrow MCP exposure of EXISTING shared_tasks commands, not a new native API.
# A done progress report is only a native submission precondition, not a result.
RESULT_TOOLS = {'cicada_read_result_state', 'cicada_submit_result', 'cicada_read_result_receipt'}
def result_tools():
    task = {'type':'string','minLength':1,'maxLength':80,'pattern':'^[A-Za-z0-9_-]+$'}
    operation = dict(IDENTITY, pattern='^[A-Za-z0-9_-]+$')
    return [
        {'name':'cicada_read_result_state','description':'Read the existing native task projection, associated reports, immutable results and review state. Read-only; no run registration or acceptance.',
         'inputSchema':schema({'taskId':task},['taskId'])},
        {'name':'cicada_submit_result','description':'Submit authorized result text from an EXISTING completed native run for human review. Native UUID/version/run/intent and replay guards remain authoritative. Does not create or finish a run, accept a review or complete a task. Reuse identical operationId/payload after an unknown outcome; inspect receipt first.',
         'inputSchema':schema({'operationId':operation,'taskId':task,'expectedVersion':{'type':'integer','minimum':1,'maximum':9007199254740990},'runId':{'type':'string','minLength':1,'maxLength':100},'content':{'type':'string','minLength':1,'maxLength':8000,'description':'Native limit is 8000 UTF-8 bytes, not 8000 Unicode characters.'}},['operationId','taskId','expectedVersion','runId','content'])},
        {'name':'cicada_read_result_receipt','description':'Read an existing operation receipt, requiring its exact task UUID and operationId to match. Unknown remains unknown; never resubmits or accepts.',
         'inputSchema':schema({'taskId':task,'operationId':operation},['taskId','operationId'])}]

def result_request(name, args):
    task = args['taskId']
    if not isinstance(task,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',task):
        raise ValueError('invalid result task identity')
    if name == 'cicada_read_result_state':
        return {'version':1,'operation_id':str(uuid.uuid4()),'action':'task-command',
                'body':{'command':'get','arguments':{'taskId':task}}}
    op = args['operationId']
    if not isinstance(op,str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}',op):
        raise ValueError('invalid result operation identity')
    if name == 'cicada_read_result_receipt':
        return {'version':1,'operation_id':str(uuid.uuid4()),'action':'task-command',
                'body':{'command':'operation','arguments':{'operationId':op}}}
    revision = args['expectedVersion']
    if type(revision) is not int or not 0 < revision < 9007199254740991:
        raise ValueError('invalid result expected version')
    for field,limit in [('runId',100),('content',8000)]:
        value = args[field]
        if not isinstance(value,str) or not value.strip() or any(ord(c)<32 and c not in '\n\t' or 127<=ord(c)<=159 for c in value):
            raise ValueError('invalid result text')
        try: bounded = len(value.encode('utf-8')) <= limit
        except UnicodeError: bounded = False
        if not bounded: raise ValueError('invalid result text')
    return {'version':1,'operation_id':op,'action':'task-command',
            'body':{'command':'submit_result','arguments':{key:copy.deepcopy(value) for key,value in args.items() if key!='operationId'}}}


def tools_for(app):
    if app == 'cicada':
        return [
            {'name':'cicada_list_tasks','description':'Read-only personal tasks; no corporate records. Empty arguments retain the legacy first page. For complete traversal pass pageSize (1-100), then nextCursor as cursor until null; restart if the queue changes.', 'inputSchema':schema({'pageSize':{'type':'integer','minimum':1,'maximum':100},'cursor':{'type':'string','pattern':'^v1:(?:[0-9a-f]{2}){1,80}$','maxLength':163}},[])},
            {'name':'cicada_read_task','description':'Read one exact personal native task UUID.', 'inputSchema':schema({'taskId':TEXT},['taskId'])},
            {'name':'cicada_begin_ai_work','description':'Register authorized work already being performed by the calling AI. Reuse an existing task UUID when known. Atomically writes task, binding, running report and receipt. No model launch or human timer. Keep operationId after timeout.',
             'inputSchema':schema({'operationId':IDENTITY,'title':TEXT,'content':TEXT,'taskId':{'type':['string','null']},'expectedVersion':{'type':['integer','null']},'projects':{'type':'array','items':TEXT},'report':REPORT},['operationId','title','content','taskId','expectedVersion','projects','report'])},
            {'name':'cicada_report_ai_work','description':'Report observed progress on the exact task and attempt. Native task completion remains a separate user decision. Reuse the original operationId and payload on timeout.',
             'inputSchema':schema({'operationId':IDENTITY,'taskId':TEXT,'expectedVersion':{'type':'integer'},'report':REPORT},['operationId','taskId','expectedVersion','report'])}] + result_tools()
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
    if set(args) - set(contract['properties']) or set(contract['required']) - set(args):
        raise ValueError('unsupported tool fields')
    if app == 'cicada' and name == 'cicada_list_tasks':
        if 'pageSize' in args and (type(args['pageSize']) is not int or not 1 <= args['pageSize'] <= 100):
            raise ValueError('invalid page size')
        if 'cursor' in args:
            cursor = args['cursor']
            if type(cursor) is not str or not re.fullmatch(r'v1:(?:[0-9a-f]{2}){1,80}', cursor):
                raise ValueError('invalid cursor')
            try:
                identity = bytes.fromhex(cursor[3:]).decode('ascii')
            except (ValueError, UnicodeError):
                raise ValueError('invalid cursor') from None
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', identity):
                raise ValueError('invalid cursor')
    if app == 'cicada' and name in RESULT_TOOLS:
        request = result_request(name,args)
        if len(json.dumps(request,ensure_ascii=False,allow_nan=False).encode('utf-8'))+1 >= MAX_FRAME:
            raise ValueError('request too large')
        value = bridge.call(request)  # No retries, run fabrication or auto-review.
        if name == 'cicada_read_result_receipt':
            if not isinstance(value,dict) or type(value.get('known')) is not bool:
                raise ValueError('invalid result receipt')
            if value['known']:
                receipt = value.get('receipt')
                if not isinstance(receipt,dict) or receipt.get('operationId') != args['operationId'] or not isinstance(receipt.get('task'),dict) or receipt['task'].get('id') != args['taskId']:
                    raise ValueError('result receipt identity mismatch')
        return value
    if app == 'cicada':
        body = copy.deepcopy(args)
        op = body.pop('operationId', str(uuid.uuid4()))
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
            if method == 'initialize': result = {'protocolVersion':params.get('protocolVersion','2025-03-26'),'capabilities':{'tools':{}},'serverInfo':{'name':app+'-local-authority','version':'1.0.0'}}
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
    endpoint = parser.add_mutually_exclusive_group(required=True)
    endpoint.add_argument('--client')
    endpoint.add_argument('--socket-directory')
    parser.add_argument('--call',help='one MCP tool name; arguments from stdin')
    args = parser.parse_args()
    bridge = (Bridge(args.app,args.profile,args.client) if args.socket_directory is None
              else Bridge(args.app,args.profile,socket_directory=args.socket_directory))
    if args.call:
        raw = sys.stdin.buffer.read(64*1024+1)
        result = invoke(args.app,bridge,args.call,parse(raw))
        print(json.dumps(result,ensure_ascii=False,allow_nan=False))
    else: serve(args.app,bridge)


if __name__ == '__main__': main()
