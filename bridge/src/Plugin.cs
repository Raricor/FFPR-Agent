using System;
using System.IO;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using BepInEx.Unity.IL2CPP;
using HarmonyLib;
using Il2CppInterop.Runtime.Injection;
using UnityEngine;

namespace FfprBridge;

/// <summary>
/// The state bridge (design doc §5): samples the game state once a second, records dialog,
/// choice, achievement and other events, and publishes them as JSON lines to a file and over
/// WebSocket; answers queries; and, on the LAN link, presses keys for the agent (control plan
/// §4.1). It never writes game state: every hook is a postfix that only reads, every call into
/// the game is a getter or a pure query, and keys go through SendInput like a keyboard.
/// </summary>
[BepInPlugin(Guid, "FFPR Agent Bridge", Version)]
public sealed class Plugin : BasePlugin
{
    public const string Guid = "ffpr.agent.bridge";
    public const string Version = "0.10.0";

    internal static ManualLogSource Logger;
    internal static Outbox Outbox;
    internal static ConfigEntry<float> SampleInterval;
    internal static ConfigEntry<bool> TrackMessageLookups;

    // 10-28: Steam runs several of the six games at once, so each listens on its own port:
    // 4780N for FFN, except FF5, the AI player's game, which keeps 47800.
#if FF1
    private const int DefaultPort = 47801;
#elif FF2
    private const int DefaultPort = 47802;
#elif FF3
    private const int DefaultPort = 47803;
#elif FF4
    private const int DefaultPort = 47804;
#elif FF6
    private const int DefaultPort = 47806;
#else
    private const int DefaultPort = 47800;
#endif

    public override void Load()
    {
        Logger = Log;
        var port = Config.Bind("Bridge", "Port", DefaultPort, "WebSocket 端口(127.0.0.1 和局域网共用),0 表示不开");
        var linkFile = Config.Bind(
            "Bridge", "LinkFile", @"C:\ffpr\bridge.json", "局域网连接的设置(地址、允许的客户端、令牌);没有这个文件就只听本机");
        SampleInterval = Config.Bind("Probe", "SampleIntervalSeconds", 1.0f, "状态采样间隔");
        TrackMessageLookups = Config.Bind(
            "Probe", "TrackMessageLookups", true, "记录 MessageManager.GetMessage 的调用,用来给对话配消息 ID");

        var dir = Path.Combine(Paths.BepInExRootPath, "ffpr");
        Directory.CreateDirectory(dir);
        var file = Path.Combine(dir, $"probe-{DateTime.Now:yyyyMMdd-HHmmss}.jsonl");
        var link = Link.Load(linkFile.Value, Log);
        Outbox = new Outbox(file, port.Value, link, Log);
        Outbox.Start();
        if (link != null)
        {
            Keyboard.Start();  // key commands come only over the LAN link, with the token
        }

        ClassInjector.RegisterTypeInIl2Cpp<Probe>();
        var host = new GameObject("FfprBridge.Probe") { hideFlags = HideFlags.HideAndDontSave };
        UnityEngine.Object.DontDestroyOnLoad(host);
        host.AddComponent<Probe>();

        var harmony = new Harmony(Guid);
        foreach (var hook in Hooks.All)
        {
            try
            {
                harmony.CreateClassProcessor(hook).Patch();
                Log.LogInfo($"已挂钩 {hook.Name}");
            }
            catch (Exception e)
            {
                // A missing method in another game or build must not take the whole probe down.
                Log.LogWarning($"挂钩 {hook.Name} 失败:{e.Message}");
            }
        }
        Log.LogInfo($"FFPR Agent Bridge {Version} 已启动,日志 {file}");
    }
}
