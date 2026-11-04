using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using BepInEx;
using BepInEx.Unity.IL2CPP;

namespace FfprBridge;

/// <summary>
/// The only BepInEx plugin the games see (0.11.0). It deliberately references no game assembly:
/// each game has its own Assembly-CSharp and its own Serial.FFn classes, so the real bridge is
/// one of six assemblies under games/. This loader identifies the game from the process name and
/// starts the matching one, which keeps a single GUID, one config file and one package for all
/// six games.
/// </summary>
[BepInPlugin(Guid, "FFPR Agent Bridge", BridgeVersion.Value)]
public sealed class Loader : BasePlugin
{
    public const string Guid = "ffpr.agent.bridge";

    private const string PluginType = "FfprBridge.Plugin";
    private const string StartMethod = "Start";

    // The executable names of the six Steam releases. Comparisons are case-insensitive and the
    // whole name must match: "FINAL FANTASY" is not "FINAL FANTASY V".
    private static readonly Dictionary<string, string> Games = new(StringComparer.OrdinalIgnoreCase)
    {
        ["FINAL FANTASY"] = "ff1",
        ["FINAL FANTASY II"] = "ff2",
        ["FINAL FANTASY III"] = "ff3",
        ["FINAL FANTASY IV"] = "ff4",
        ["FINAL FANTASY V"] = "ff5",
        ["FINAL FANTASY VI"] = "ff6",
    };

    public override void Load()
    {
        var process = Paths.ProcessName;
        if (!Games.TryGetValue(process, out var game))
        {
            Log.LogWarning($"不认识的游戏进程 {process},桥插件不启动");
            return;
        }

        var dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        var file = Path.Combine(dir, "games", $"FfprBridge.{game}.dll");
        if (!File.Exists(file))
        {
            Log.LogError($"缺少 {file},桥插件不启动");
            return;
        }

        try
        {
            var plugin = Assembly.LoadFrom(file);
            var type = plugin.GetType(PluginType);
            if (type == null)
            {
                Log.LogError($"{game}:{Path.GetFileName(file)} 里找不到类型 {PluginType}");
                return;
            }

            var start = type.GetMethod(StartMethod, BindingFlags.Public | BindingFlags.Static);
            if (start == null)
            {
                Log.LogError($"{game}:{PluginType} 里找不到静态方法 {StartMethod}(BasePlugin)");
                return;
            }

            start.Invoke(null, new object[] { this });
            Log.LogInfo($"认出 {game}({process}),加载 {Path.GetFileName(file)}");
        }
        catch (TargetInvocationException e)
        {
            var inner = e.InnerException ?? e;
            Log.LogError($"启动 {game} 的桥插件失败:{inner.Message}\n{inner.StackTrace}");
        }
        catch (Exception e)
        {
            Log.LogError($"加载 {game} 的桥插件失败:{e.Message}\n{e.StackTrace}");
        }
    }
}
