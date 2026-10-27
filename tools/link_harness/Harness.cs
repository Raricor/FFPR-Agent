using System;
using System.IO;
using System.Net.WebSockets;
using System.Text.Json.Nodes;
using System.Threading;

namespace BepInEx.Logging
{
    /// <summary>Stand-in for BepInEx's logger: prints to stderr.</summary>
    public sealed class ManualLogSource
    {
        public void LogInfo(object data) => Console.Error.WriteLine($"[info] {data}");

        public void LogWarning(object data) => Console.Error.WriteLine($"[warn] {data}");

        public void LogError(object data) => Console.Error.WriteLine($"[error] {data}");
    }
}

namespace FfprBridge
{
    internal static class Probe
    {
        internal static volatile int Frame;
    }

    /// <summary>Stand-in for the key thread: answers every command as if all keys were sent.</summary>
    internal static class Keyboard
    {
        public static void Enqueue(WebSocket from, string text)
        {
            var command = JsonNode.Parse(text)!.AsObject();
            var reply = new JsonObject
            {
                ["type"] = "reply",
                ["re"] = command["id"]?.GetValue<int>(),
                ["op"] = command["op"]?.GetValue<string>(),
                ["ok"] = true,
                ["sent"] = command["keys"]?.AsArray().Count ?? 0,
            };
            if (command["op"]?.GetValue<string>() == "status")
            {
                reply["focused"] = true;
                reply["locked"] = false;
                reply["foreground"] = "harness";
            }
            Harness.Outbox.Reply(from, reply.ToJsonString());
        }
    }

    /// <summary>
    /// harness &lt;port&gt; &lt;link.json&gt; &lt;probe file&gt;: plays the game thread. Answers each query
    /// with its own fields under the op's name, posts a sample every 100 ms, and exits when
    /// stdin closes.
    /// </summary>
    internal static class Harness
    {
        internal static Outbox Outbox;

        private static int Main(string[] args)
        {
            var log = new BepInEx.Logging.ManualLogSource();
            Outbox = new Outbox(args[2], int.Parse(args[0]), Link.Load(args[1], log), log);
            Outbox.Hello = "{\"type\":\"hello\",\"plugin\":\"harness\"}";
            Outbox.Start();
            new Thread(() => { Console.In.ReadToEnd(); Environment.Exit(0); }) { IsBackground = true }.Start();
            Console.WriteLine("ready");
            for (var seq = 1; ; seq++)
            {
                Probe.Frame = seq;
                while (Outbox.Requests.TryDequeue(out var request))
                {
                    var query = JsonNode.Parse(request.Text)!.AsObject();
                    var op = query["op"]!.GetValue<string>();
                    var reply = new JsonObject
                    {
                        ["type"] = "reply",
                        ["re"] = query["id"]?.GetValue<int>(),
                        ["op"] = op,
                        ["ok"] = true,
                        [op] = JsonNode.Parse(query.ToJsonString()),
                    };
                    Outbox.Reply(request.From, reply.ToJsonString());
                }
                if (seq % 10 == 0)
                {
                    Outbox.Post($"{{\"seq\":{seq},\"type\":\"sample\"}}");
                }
                Thread.Sleep(10);
            }
        }
    }
}
