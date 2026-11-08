using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

namespace Artoo.QuickJsProcessHost;

internal sealed record FilePin(string Path, long Bytes, string Sha256);
internal sealed record Launch(FilePin Node, FilePin Entry, FilePin Configuration, FilePin[] RuntimeFiles, string Cwd, int LifetimeMs);
internal sealed record Control(string Kind, string Nonce, byte[]? Data);

// Modes are selected only by fixed local executable selectors, never launch JSON.
internal sealed record OwnerMode(string EntryName, string ConfigurationName, string Selector, string AdmissionProtocol, int InputBytes, int StdoutBytes, int HelperBytes, int Writes)
{
    internal static readonly OwnerMode Runtime = new("application-runtime.mjs", "application-runtime.json", "--application-runtime-v1", "artoo.application-runtime.v1", Protocol.InputBytes, Protocol.StdoutBytes, Protocol.HelperBytes, Protocol.Writes);
    // Raw compiler JSON: no nested runtime frames. Reserve 256 bytes for admission.
    internal static readonly OwnerMode Compiler = new("application-compiler-process.mjs", "application-compiler-process.json", "--application-compiler-process-v1", "artoo.application-compiler-process.v1", 52 * 1024 * 1024 + 256, 100 * 1024 * 1024, 144 * 1024 * 1024, 4096);
}

internal static class Protocol
{
    internal const int LineBytes = 65536, InputBytes = 8388608, WriteBytes = 16384, Writes = 2048;
    internal const int StdoutBytes = 16777216, StderrBytes = 16384, HelperBytes = 25165824, CleanupMs = 5000;
    internal static readonly UTF8Encoding Utf8 = new(false, true);

    internal static JsonDocument Parse(byte[] bytes) => JsonDocument.Parse(Utf8.GetString(bytes), new JsonDocumentOptions { MaxDepth = 16 });
    internal static void Exact(JsonElement element, params string[] names) {
        Native.Require(element.ValueKind == JsonValueKind.Object, "control-object");
        var left = new HashSet<string>(names, StringComparer.Ordinal);
        foreach (var member in element.EnumerateObject()) Native.Require(left.Remove(member.Name), "control-fields");
        Native.Require(left.Count == 0, "control-fields");
    }
    internal static string String(JsonElement element, string name, int maximum) {
        var value = element.GetProperty(name);
        Native.Require(value.ValueKind == JsonValueKind.String, "control-string");
        string text = value.GetString()!;
        Native.Require(text.Length > 0 && text.Length <= maximum && !text.Contains('\0'), "control-string");
        return text;
    }
    internal static int Number(JsonElement element, string name, int minimum, int maximum) {
        Native.Require(element.GetProperty(name).TryGetInt32(out int value) && value >= minimum && value <= maximum, "control-number");
        return value;
    }
    internal static string PathName(string path) {
        Native.Require(path.Length is >= 3 and <= 32760 && char.IsAsciiLetter(path[0]) && path[1] == ':' && path[2] == '\\'
            && !path[2..].Contains(':') && !path.Contains('/') && !path.Contains('\0')
            && string.Equals(Path.GetFullPath(path), path, StringComparison.OrdinalIgnoreCase), "pin-path");
        foreach (string part in path[3..].Split('\\')) Native.Require(part.Length > 0 && !part.EndsWith(' ') && !part.EndsWith('.'), "pin-path");
        return path;
    }
    private static FilePin Pin(JsonElement element) {
        Exact(element, "path", "bytes", "sha256");
        string path = PathName(String(element, "path", 32760));
        int bytes = Number(element, "bytes", 1, 268435456);
        string digest = String(element, "sha256", 71);
        Native.Require(digest.Length == 71 && digest.StartsWith("sha256:", StringComparison.Ordinal)
            && digest[7..].All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f'), "pin-hash");
        return new FilePin(path, bytes, digest);
    }
    internal static Launch ReadLaunch(byte[] bytes, OwnerMode mode) {
        using var document = Parse(bytes); var root = document.RootElement;
        Exact(root, "version", "kind", "node", "entry", "configuration", "runtimeFiles", "cwd", "lifetimeMs");
        Native.Require(Number(root, "version", 1, 1) == 1 && String(root, "kind", 16) == "launch", "launch-kind");
        FilePin node = Pin(root.GetProperty("node")), entry = Pin(root.GetProperty("entry")), configuration = Pin(root.GetProperty("configuration"));
        Native.Require(string.Equals(Path.GetFileName(node.Path), "node.exe", StringComparison.OrdinalIgnoreCase)
            && Path.GetFileName(entry.Path) == mode.EntryName
            && Path.GetFileName(configuration.Path) == mode.ConfigurationName, "launch-fixed-files");
        string cwd = PathName(String(root, "cwd", 32760));
        Native.Require(string.Equals(cwd, Path.GetDirectoryName(entry.Path), StringComparison.Ordinal)
            && string.Equals(cwd, Path.GetDirectoryName(configuration.Path), StringComparison.Ordinal), "launch-cwd");
        var files = root.GetProperty("runtimeFiles");
        Native.Require(files.ValueKind == JsonValueKind.Array && files.GetArrayLength() <= 1024, "launch-files");
        var launch = new Launch(node, entry, configuration, files.EnumerateArray().Select(Pin).ToArray(), cwd, Number(root, "lifetimeMs", 1, 30000));
        // Same physical role may be repeated only with exactly the same pin.
        // Windows directories can opt into case sensitivity. Distinct spellings
        // must each retain/verify their own handles rather than collapse a path
        // to an unverified sibling. Canonical duplicates share one pin.
        var distinct = new Dictionary<string, FilePin>(StringComparer.Ordinal);
        foreach (FilePin pin in AllPins(launch)) {
            if (distinct.TryGetValue(pin.Path, out var previous)) Native.Require(previous.Bytes == pin.Bytes && previous.Sha256 == pin.Sha256, "pin-conflict");
            else distinct.Add(pin.Path, pin);
        }
        Native.Require(distinct.Count <= 1024 && distinct.Values.Sum(pin => pin.Bytes) <= 536870912, "pin-total");
        return launch;
    }
    internal static IEnumerable<FilePin> AllPins(Launch launch) => new[] { launch.Node, launch.Entry, launch.Configuration }.Concat(launch.RuntimeFiles);
    internal static Control ReadControl(byte[] bytes, int sequence, OwnerMode mode) {
        using var document = Parse(bytes); var root = document.RootElement;
        string kind = String(root, "kind", 16);
        Native.Require(kind is "write" or "close-input" or "cancel", "control-kind");
        if (kind == "write") Exact(root, "version", "sequence", "kind", "nonce", "data");
        else Exact(root, "version", "sequence", "kind", "nonce");
        Native.Require(Number(root, "version", 1, 1) == 1 && Number(root, "sequence", 0, mode.Writes + 1) == sequence, "control-sequence");
        string nonce = String(root, "nonce", 36);
        Native.Require(Guid.TryParseExact(nonce, "D", out _), "control-nonce");
        byte[]? data = null;
        if (kind == "write") {
            string encoded = String(root, "data", 4 * ((WriteBytes + 2) / 3));
            data = Convert.FromBase64String(encoded);
            Native.Require(data.Length is >= 1 and <= WriteBytes && Convert.ToBase64String(data) == encoded, "control-base64");
        }
        return new Control(kind, nonce, data);
    }
}

// One reader owns the actual parent pipe. A partial final line is never EOF.
internal sealed class LineReader(Stream stream)
{
    private readonly byte[] buffer = new byte[4096];
    private int offset, length;
    internal byte[]? Read() {
        using var line = new MemoryStream();
        for (;;) {
            if (offset == length) {
                length = stream.Read(buffer, 0, buffer.Length); offset = 0;
                if (length == 0) {
                    Native.Require(line.Length == 0, "control-partial-line");
                    return null;
                }
            }
            byte value = buffer[offset++];
            Native.Require(line.Length + 1 <= Protocol.LineBytes, "control-line-limit");
            if (value == 10) return line.ToArray();
            line.WriteByte(value);
        }
    }
}

// An unresponsive parent must not block the deadline/termination owner. Producers
// enqueue bounded copied frames; only this background thread writes helper stdout.
internal sealed class FrameWriter
{
    private readonly object gate = new();
    private readonly BlockingCollection<byte[]> queue = new(new ConcurrentQueue<byte[]>());
    private readonly TaskCompletionSource<bool> completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Action<string> stop;
    private readonly int maximumBytes;
    private long sequence, pendingBytes, totalBytes;
    private bool terminal, closed;
    internal FrameWriter(Action<string> stop, int maximumBytes) {
        this.stop = stop; this.maximumBytes = maximumBytes;
        new Thread(WriteLoop) { IsBackground = true, Name = "artoo-quickjs-helper-output" }.Start();
    }
    internal bool Send(string kind, object payload) {
        lock (gate) {
            if (closed || terminal) return false;
            byte[] json = JsonSerializer.SerializeToUtf8Bytes(new { version = 1, sequence, kind, payload });
            if (json.Length + 1 > Protocol.LineBytes || pendingBytes + json.Length + 1 > 1048576 || totalBytes + json.Length + 1 > maximumBytes) {
                stop("helper-output-limit"); return false;
            }
            byte[] line = new byte[json.Length + 1]; json.CopyTo(line, 0); line[^1] = 10;
            sequence++; pendingBytes += line.Length; totalBytes += line.Length;
            if (kind == "terminal") terminal = true;
            queue.Add(line); return true;
        }
    }
    internal void Complete() { lock (gate) { if (!closed) { closed = true; queue.CompleteAdding(); } } }
    internal bool Wait(int milliseconds) => completion.Task.Wait(milliseconds) && completion.Task.Result;
    private void WriteLoop() {
        try {
            using Stream output = Console.OpenStandardOutput();
            foreach (byte[] bytes in queue.GetConsumingEnumerable()) {
                output.Write(bytes, 0, bytes.Length); output.Flush();
                lock (gate) pendingBytes -= bytes.Length;
            }
            completion.TrySetResult(true);
        } catch { stop("helper-output-io"); completion.TrySetResult(false); }
    }
}
