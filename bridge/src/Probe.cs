using System;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using UnityEngine;

namespace FfprBridge;

/// <summary>Builds one JSON line per record: a common header, then the record's own fields.</summary>
internal static class Emit
{
    private static readonly JsonSerializerOptions Json = new()
    {
        // Keep Chinese text readable in the file.
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static long _seq;

    public static void Event(string type, Action<JsonObject> fill)
    {
        var record = new JsonObject
        {
            ["seq"] = Interlocked.Increment(ref _seq),
            ["t"] = DateTime.UtcNow.ToString("O"),
            ["frame"] = Probe.Frame,
            ["type"] = type,
        };
        try
        {
            fill(record);
        }
        catch (Exception e)
        {
            record["error"] = $"{e.GetType().Name}: {e.Message}";
        }
        var line = Serialize(record);
        if (type == "hello")
        {
            Plugin.Outbox.Hello = line;
        }
        Plugin.Outbox.Post(line);
    }

    public static string Serialize(JsonNode node) => node.ToJsonString(Json);
}

/// <summary>Lives on a hidden GameObject and samples the game state on the game thread.</summary>
public sealed class Probe : MonoBehaviour
{
    /// <summary>Last frame seen on the game thread; hooks read it instead of calling Unity.</summary>
    internal static volatile int Frame;

    private readonly System.Collections.Generic.HashSet<string> _reported = new();
    private float _elapsed;
    private bool _helloSent;

    public Probe(IntPtr ptr) : base(ptr)
    {
    }

    public void Update()
    {
        Frame = Time.frameCount;
        try
        {
            MapWatch.Update();
            PosWatch.Update();
            Requests.Drain();
            GameInput.Drain();
        }
        catch (Exception e)
        {
            // Keep sampling even if these fail; report each distinct failure once.
            if (_reported.Add(e.Message))
            {
                Plugin.Logger.LogWarning($"MapWatch/Requests:{e}");
            }
        }
        if (!_helloSent)
        {
            _helloSent = true;
            Emit.Event("hello", o =>
            {
                o["plugin"] = Plugin.Version;
                o["product"] = Application.productName;
                o["gameVersion"] = Application.version;
                o["unity"] = Application.unityVersion;
            });
        }

        _elapsed += Time.unscaledDeltaTime;
        if (_elapsed < Plugin.SampleInterval.Value)
        {
            return;
        }
        _elapsed = 0f;
        Emit.Event("sample", o =>
        {
            GameState.Fill(o);
            o["dropped"] = Plugin.Outbox.Dropped;
        });
    }
}
