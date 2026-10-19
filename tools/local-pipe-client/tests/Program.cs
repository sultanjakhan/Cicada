using System.Diagnostics;
using System.IO.Pipes;
using System.Text;

if (args.Length < 2 || args.Length > 3) return 2;
var client = Path.GetFullPath(args[0]);
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
await process.StandardInput.WriteAsync(Encoding.UTF8.GetString(frame), stdioDeadline.Token);
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
