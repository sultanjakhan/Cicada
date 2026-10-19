using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Reflection;

if (args.Length < 2 || args.Length > 3) return 2;
var client = Path.GetFullPath(args[0]);
if (args[1] == "frames") return await FrameFixture.Run(client);
var prefix = args.Length == 3 ? args[2] : "CicadaAgent";
if (prefix is not ("CicadaAgent" or "AgentCityAgent")) return 2;
var name = $"{prefix}-0123456789abcdef0123456789abcdef";
var frame = Encoding.UTF8.GetBytes("{\"version\":1,\"action\":\"get\"}\n");
var response = Encoding.UTF8.GetBytes("{\"ok\":true,\"result\":{}}\n");

await using var first = new NamedPipeServerStream(name, PipeDirection.InOut, 1,
    PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly, 65536, 1048576);
await using var holder = new NamedPipeClientStream(".", name, PipeDirection.InOut,
    PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
await holder.ConnectAsync(3000);
await first.WaitForConnectionAsync().WaitAsync(TimeSpan.FromSeconds(5));

var sw = Stopwatch.StartNew();
var psi = new ProcessStartInfo(client, name) { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
using var process = Process.Start(psi)!;
using var stdioDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
await process.StandardInput.WriteAsync(Encoding.UTF8.GetString(frame).AsMemory(), stdioDeadline.Token);
await process.StandardInput.FlushAsync(stdioDeadline.Token);
process.StandardInput.Close();
var outputTask = process.StandardOutput.ReadToEndAsync();
var errorTask = process.StandardError.ReadToEndAsync();
await Task.Delay(4000);
await holder.DisposeAsync();
await first.DisposeAsync();

if (args[1] is "baseline" or "agentcity")
{
    await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
    var baselineOutput = await outputTask.WaitAsync(TimeSpan.FromSeconds(5));
    var baselineError = await errorTask.WaitAsync(TimeSpan.FromSeconds(5));
    var timeout = baselineError.Contains("TimeoutException", StringComparison.Ordinal);
    var elapsed = sw.Elapsed;
    var nearThreeSeconds = elapsed >= TimeSpan.FromSeconds(2) && elapsed <= TimeSpan.FromSeconds(6);
    Console.WriteLine($"mode={args[1]} prefix={prefix} exit={process.ExitCode} elapsedMs={sw.ElapsedMilliseconds} frameCount=0 ack=false stdoutBytes={Encoding.UTF8.GetByteCount(baselineOutput)} stderrClass={baselineError.Trim()}");
    return process.ExitCode == 2 && timeout && nearThreeSeconds ? 0 : 1;
}

await using var second = new NamedPipeServerStream(name, PipeDirection.InOut, 1,
    PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly, 65536, 1048576);
await second.WaitForConnectionAsync().WaitAsync(TimeSpan.FromSeconds(10));
var received = new byte[frame.Length];
var got = 0;
using var ioDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
while (got < received.Length)
{
    var read = await second.ReadAsync(received.AsMemory(got), ioDeadline.Token);
    if (read == 0) throw new EndOfStreamException("server closed before request frame");
    got += read;
}
await second.WriteAsync(response); await second.FlushAsync();
var ack = new byte[1]; var ackCount = await second.ReadAsync(ack, ioDeadline.Token);
if (ackCount == 0) throw new EndOfStreamException("client closed before ACK");
await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); sw.Stop();
var output = await outputTask.WaitAsync(TimeSpan.FromSeconds(5));
var error = await errorTask.WaitAsync(TimeSpan.FromSeconds(5));
var exact = received.SequenceEqual(frame);
Console.WriteLine($"mode={args[1]} exit={process.ExitCode} elapsedMs={sw.ElapsedMilliseconds} frameCount={(exact ? 1 : 0)} ack={(ackCount == 1 && ack[0] == 10)} stdoutBytes={Encoding.UTF8.GetByteCount(output)} stderrClass={error.Trim()}");
if (args[1] == "baseline") return process.ExitCode == 2 && !exact ? 0 : 1;
return process.ExitCode == 0 && exact && ackCount == 1 && ack[0] == 10 ? 0 : 1;

internal static class FrameFixture
{
    const int InputLimit=64*1024, OutputLimit=1024*1024;
    static readonly byte[] Request=Encoding.UTF8.GetBytes("{\"version\":1,\"action\":\"get\"}\n");
    static byte[] JsonFrame(int totalBytes) => Encoding.UTF8.GetBytes("{\"ok\":true,\"result\":\""+new string('x',totalBytes-24)+"\"}\n");
    static void Require(bool value,string reason) {if(!value) throw new InvalidDataException(reason);}

    // Exercise the actual compiled client's Read, not a copy of its algorithm.
    // This deterministic budget fails the old one-byte reader irrespective of
    // runner speed; the real pipe case below also uses the unchanged 3s deadline.
    sealed class CountedStream(byte[] bytes,int chunk=8192) : MemoryStream(bytes)
    {
        public int Reads;
        public override ValueTask<int> ReadAsync(Memory<byte> buffer,CancellationToken ct=default)
        {
            if(++Reads>128) throw new InvalidDataException("unbuffered_read_budget");
            return base.ReadAsync(buffer[..Math.Min(buffer.Length,chunk)],ct);
        }
    }
    sealed class CancelledReadStream : MemoryStream
    {
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer,CancellationToken ct=default)
        {await Task.Delay(Timeout.Infinite,ct);return 0;}
    }
    static async Task ReaderCases(string client)
    {
        var assembly=Assembly.LoadFrom(Path.ChangeExtension(client,".dll"));
        var method=assembly.GetTypes().SelectMany(t=>t.GetMethods(BindingFlags.NonPublic|BindingFlags.Static))
            .Single(m=>m.Name.Contains("g__Read|") && m.GetParameters().Length==3);
        Task<byte[]> Read(Stream stream,int limit,CancellationToken ct) => (Task<byte[]>)method.Invoke(null,[stream,limit,ct])!;
        var large=JsonFrame(440*1024);Require(large.Length==440*1024,"fixture_length");
        using(var stream=new CountedStream(large))
        {
            var result=await Read(stream,OutputLimit,CancellationToken.None);
            Require(result.SequenceEqual(large[..^1]) && stream.Reads<=56,"large_buffered_reader");
        }
        foreach(var chunk in new[]{1,3,8192})
        {
            using var stream=new CountedStream(Encoding.UTF8.GetBytes("{\"ok\":true}\n"),chunk);
            Require(Encoding.UTF8.GetString(await Read(stream,InputLimit,CancellationToken.None))=="{\"ok\":true}","split_frame");
        }
        using(var stream=new MemoryStream(JsonFrame(OutputLimit)))
            Require((await Read(stream,OutputLimit,CancellationToken.None)).Length==OutputLimit-1,"exact_frame_limit");
        using(var stream=new MemoryStream(JsonFrame(InputLimit)))
            Require((await Read(stream,InputLimit,CancellationToken.None)).Length==InputLimit-1,"exact_input_limit");
        foreach(var bytes in new[]{JsonFrame(OutputLimit+1),Encoding.UTF8.GetBytes("{}"),Encoding.UTF8.GetBytes("{}\n{}\n")})
        {
            using var stream=new MemoryStream(bytes);bool rejected=false;
            try {await Read(stream,OutputLimit,CancellationToken.None);} catch(Exception e) when(e is InvalidDataException or EndOfStreamException) {rejected=true;}
            Require(rejected,"oversize_eof_or_extra_frame_accepted");
        }
        using var cancelled=new CancellationTokenSource();cancelled.Cancel();bool stopped=false;
        try {await Read(new MemoryStream(Request),InputLimit,cancelled.Token);} catch(OperationCanceledException) {stopped=true;}
        Require(stopped,"cancellation_ignored");
        using var midRead=new CancellationTokenSource(TimeSpan.FromMilliseconds(50));stopped=false;
        try {await Read(new CancelledReadStream(),InputLimit,midRead.Token);} catch(OperationCanceledException) {stopped=true;}
        Require(stopped,"pending_read_cancellation_ignored");
        Console.WriteLine("compiled-reader buffered440KiB splitLF exact-limit EOF extra-frame cancellation PASS");
    }

    static async Task PipeCase(string client,string label,byte[] input,byte[] response,bool success,bool split=false,bool connect=true)
    {
        var name="CicadaAgent-"+Guid.NewGuid().ToString("N");
        await using var server=new NamedPipeServerStream(name,PipeDirection.InOut,1,PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly,65536,65536);
        var psi=new ProcessStartInfo(client,name){UseShellExecute=false,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
        using var process=Process.Start(psi)!;var output=process.StandardOutput.ReadToEndAsync();var error=process.StandardError.ReadToEndAsync();
        try {await process.StandardInput.BaseStream.WriteAsync(input);process.StandardInput.Close();}
        catch(IOException) when(!success) { }
        bool acked=false;long elapsed=0;
        if(connect)
        {
            await server.WaitForConnectionAsync().WaitAsync(TimeSpan.FromSeconds(5));
            using var requestDeadline=new CancellationTokenSource(TimeSpan.FromSeconds(3));
            var received=new byte[Request.Length];await server.ReadExactlyAsync(received,requestDeadline.Token);
            Require(received.SequenceEqual(Request),label+" request changed");
            var watch=Stopwatch.StartNew();
            using var deadline=new CancellationTokenSource(TimeSpan.FromSeconds(3));
            try
            {
                if(split && response.Length>1)
                {
                    for(int offset=0;offset<response.Length-1;offset+=4093)
                        await server.WriteAsync(response.AsMemory(offset,Math.Min(4093,response.Length-1-offset)),deadline.Token);
                    await server.WriteAsync(response.AsMemory(response.Length-1),deadline.Token);
                }
                else await server.WriteAsync(response,deadline.Token);
                await server.FlushAsync(deadline.Token);
                if(success)
                {
                    var ack=new byte[1];await server.ReadExactlyAsync(ack,deadline.Token);acked=ack[0]==10;
                }
            }
            catch(IOException) when(!success) { }
            if(!success && (response.Length==0 || response[^1]!=10)) server.Disconnect();
            elapsed=watch.ElapsedMilliseconds;
        }
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(8));
        var stdout=await output;var stderr=await error;
        Require(process.ExitCode==(success?0:2),label+" exit "+stderr);
        if(success) Require(acked && stdout==Encoding.UTF8.GetString(response[..^1])+Environment.NewLine && elapsed<3000,label+" ACK/deadline/bytes");
        else Require(stdout.Trim()=="{\"ok\":false,\"error\":\"application_unavailable_or_outcome_unknown\"}",label+" failure envelope");
        Console.WriteLine($"frame={label} bytes={response.Length} exit={process.ExitCode} ack={acked} elapsedMs={elapsed}");
    }
    public static async Task<int> Run(string client)
    {
        await ReaderCases(client);
        await PipeCase(client,"snapshot440KiB",Request,JsonFrame(440*1024),true);
        await PipeCase(client,"split440KiB",Request,JsonFrame(440*1024),true,true);
        await PipeCase(client,"exactOutputLimit",Request,JsonFrame(OutputLimit),true);
        await PipeCase(client,"oversizedOutput",Request,JsonFrame(OutputLimit+1),false);
        await PipeCase(client,"invalidUtf8",Request,new byte[]{0x7b,0xff,0x7d,10},false);
        await PipeCase(client,"invalidJson",Request,Encoding.UTF8.GetBytes("{]\n"),false);
        await PipeCase(client,"deepOutput",Request,Encoding.UTF8.GetBytes(new string('[',65)+"0"+new string(']',65)+"\n"),false);
        await PipeCase(client,"eofBeforeLF",Request,Encoding.UTF8.GetBytes("{}"),false);
        await PipeCase(client,"invalidInput",Encoding.UTF8.GetBytes("{]\n"),[],false,connect:false);
        await PipeCase(client,"oversizedInput",new byte[InputLimit+1],[],false,connect:false);
        await PipeCase(client,"deepInput",Encoding.UTF8.GetBytes(new string('[',33)+"0"+new string(']',33)+"\n"),[],false,connect:false);
        Console.WriteLine("BUFFERED_PIPE_FRAME_FIXTURE_PASS");return 0;
    }
}
