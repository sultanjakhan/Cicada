using System.IO.Pipes;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Text;

const int InputLimit = 64 * 1024, OutputLimit = 1024 * 1024;
async Task<byte[]> Read(Stream stream, int limit, CancellationToken ct)
{
    using var data = new MemoryStream();var one = new byte[1];
    while (data.Length < limit)
    {
        if (await stream.ReadAsync(one, ct) == 0) throw new EndOfStreamException();
        if (one[0] == 10) return data.ToArray();data.WriteByte(one[0]);
    }
    throw new InvalidDataException();
}
try
{
    if (args.Length != 1 || !Regex.IsMatch(args[0], "^(CicadaAgent|AgentCityAgent)-[a-f0-9]{32}$")) throw new InvalidDataException();
    using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(40));
    var raw = await Read(Console.OpenStandardInput(), InputLimit, deadline.Token);
    using var doc = JsonDocument.Parse(new UTF8Encoding(false, true).GetString(raw), new JsonDocumentOptions { MaxDepth = 32 });
    using var pipe = new NamedPipeClientStream(".", args[0], PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
    await pipe.ConnectAsync(args[0].StartsWith("CicadaAgent-", StringComparison.Ordinal) ? 15000 : 3000, deadline.Token);
    await pipe.WriteAsync(raw, deadline.Token);await pipe.WriteAsync(new byte[] {10}, deadline.Token);await pipe.FlushAsync(deadline.Token);
    var response = await Read(pipe, OutputLimit, deadline.Token);
    using var reply = JsonDocument.Parse(new UTF8Encoding(false,true).GetString(response));
    // Native Tokio servers wait for consumption before disconnecting their
    // reusable pipe. Do not FlushFileBuffers an acknowledgement with no reader.
    try { await pipe.WriteAsync(new byte[] {10}, deadline.Token); }
    catch (Exception error) when (error is IOException or InvalidOperationException or OperationCanceledException) { }
    await Console.OpenStandardOutput().WriteAsync(response);Console.WriteLine();return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(error.GetType().Name);
    Console.WriteLine("{\"ok\":false,\"error\":\"application_unavailable_or_outcome_unknown\"}");return 2;
}
