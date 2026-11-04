using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using HarmonyLib;
using Il2CppInterop.Runtime.InteropTypes.Arrays;
using Last.Battle;
using Last.Management;
using Last.Message;
using Last.Systems;

namespace FfprBridge;

/// <summary>
/// Event hooks. All are postfixes that read arguments and results and publish them; none
/// changes an argument, a result or any game object.
/// </summary>
internal static class Hooks
{
    public static readonly Type[] All =
    {
        typeof(MessageLookup),
        typeof(DialogPlay),
        typeof(DialogClose),
        typeof(SelectOpen),
        typeof(ChoiceOpen),
        typeof(SystemMessage),
        typeof(SteamUnlock),
        typeof(SteamProgress),
        typeof(AchievementProgress),
        typeof(BestiaryRegister),
        typeof(SaveWrite),
        typeof(BattleActStart),
        typeof(BattleHit),
#if FF5
        typeof(BattleAiScriptInstantiate),
        typeof(BattleAiScriptExecute),
        typeof(BattleAiScriptEventCommand),
        typeof(BattleAiScriptSelect),
#endif
    };

    /// <summary>
    /// Dialog content arrives without its message ID, so remember the IDs looked up since the
    /// previous dialog and match them to the dialog by text.
    /// </summary>
    [HarmonyPatch(typeof(MessageManager), nameof(MessageManager.GetMessage))]
    private static class MessageLookup
    {
        private static void Postfix(string key, string __result)
        {
            if (Plugin.TrackMessageLookups.Value && !Lookups.Suppressed)
            {
                Lookups.Add(key, __result);
            }
        }
    }

    [HarmonyPatch(typeof(MessageWindowManager), nameof(MessageWindowManager.Play))]
    private static class DialogPlay
    {
        private static void Postfix(MessageWindowManager __instance, bool isAuto)
        {
            Emit.Event("dialog.play", o =>
            {
                var lines = GameState.Strings(__instance.messageList);
                o["state"] = GameState.MainState();
                o["field"] = __instance.isFieldWindow;
                o["auto"] = isAuto;
                o["speaker"] = __instance.spekerValue;
                o["lines"] = lines;
                var (matched, recent) = Lookups.Take(lines);
                o["ids"] = matched;
                o["lookups"] = recent;
            });
        }
    }

    [HarmonyPatch(typeof(MessageWindowManager), nameof(MessageWindowManager.Close))]
    private static class DialogClose
    {
        private static void Postfix() => Emit.Event("dialog.close", o => o["state"] = GameState.MainState());
    }

    [HarmonyPatch(typeof(MessageSelectWindowManager), nameof(MessageSelectWindowManager.Play))]
    private static class SelectOpen
    {
        private static void Postfix(MessageSelectWindowManager __instance, int defaultIndex)
        {
            Emit.Event("choice.open", o =>
            {
                o["kind"] = "select";
                o["state"] = GameState.MainState();
                o["default"] = defaultIndex;
                o["options"] = GameState.Strings(__instance.messageList);
                o["labels"] = GameState.ChoiceLabels("select");
            });
        }
    }

    [HarmonyPatch(typeof(MessageChoiceWindowManager), nameof(MessageChoiceWindowManager.Play), typeof(Il2CppStringArray))]
    private static class ChoiceOpen
    {
        private static void Postfix(MessageChoiceWindowManager __instance)
        {
            Emit.Event("choice.open", o =>
            {
                o["kind"] = "multiple";
                o["state"] = GameState.MainState();
                o["options"] = GameState.Strings(__instance.messageList);
            });
        }
    }

    /// <summary>System messages: item gets, chest contents and the like.</summary>
    [HarmonyPatch(typeof(SystemMessageWindowManager), nameof(SystemMessageWindowManager.SetMessage))]
    private static class SystemMessage
    {
        private static void Postfix(string messageId)
        {
            Emit.Event("sysmsg", o =>
            {
                o["state"] = GameState.MainState();
                o["id"] = messageId;
                o["text"] = GameState.Text(messageId);
            });
        }
    }

    /// <summary>
    /// The game re-sends its Steam achievements and stats after every map change and battle,
    /// unchanged, so the hooks below report a key only when its value differs from the last one
    /// seen in this session.
    /// </summary>
    private static readonly Dictionary<string, string> LastSeen = new();

    private static bool Changed(string key, string value)
    {
        lock (LastSeen)
        {
            if (LastSeen.TryGetValue(key, out var last) && last == value)
            {
                return false;
            }
            LastSeen[key] = value;
            return true;
        }
    }

    /// <summary>
    /// SetAchievment is called with stat-style names ("monster_hunt", "scenario_1") together
    /// with SetAchievmentProgress; it is a report to Steam, not proof of a new unlock.
    /// </summary>
    [HarmonyPatch(typeof(SteamSDKManager), nameof(SteamSDKManager.SetAchievment))]
    private static class SteamUnlock
    {
        private static void Postfix(string apiName)
        {
            if (Changed("set:" + apiName, ""))
            {
                Emit.Event("steam.setAchievement", o => o["api"] = apiName);
            }
        }
    }

    [HarmonyPatch(typeof(SteamSDKManager), nameof(SteamSDKManager.SetAchievmentProgress))]
    private static class SteamProgress
    {
        private static void Postfix(string apiName, int value)
        {
            if (!Changed("progress:" + apiName, value.ToString()))
            {
                return;
            }
            Emit.Event("steam.setProgress", o =>
            {
                o["api"] = apiName;
                o["value"] = value;
            });
        }
    }

    [HarmonyPatch(typeof(AchievementManager), nameof(AchievementManager.SetProgress))]
    private static class AchievementProgress
    {
        private static void Postfix(
            AchievementManager __instance, AchievementManager.Type type, int achievementValue, int conditionValue,
            bool isAdditional)
        {
            var now = __instance.GetProgress(type, conditionValue);
            if (!Changed($"game:{type}:{conditionValue}", $"{achievementValue}/{now}"))
            {
                return;
            }
            Emit.Event("achievement.progress", o =>
            {
                o["kind"] = type.ToString();
                o["value"] = achievementValue;
                o["condition"] = conditionValue;
                o["additional"] = isAdditional;
                o["now"] = now;
            });
        }
    }

    /// <summary>A save written from the save list: which slot, and whether it succeeded.</summary>
    [HarmonyPatch(typeof(Last.UI.KeyInput.SaveListController), nameof(Last.UI.KeyInput.SaveListController.Save))]
    private static class SaveWrite
    {
        private static void Postfix(Last.UI.KeyInput.SaveListController __instance, Il2CppSystems.Files.FileOperationUtility.ResultCode __result)
        {
            Emit.Event("save.write", o =>
            {
                o["slot"] = __instance.CurrentSlotData?.Id;
                o["result"] = __result.ToString();
            });
        }
    }

    /// <summary>
    /// 0.13.0: InitPrepareState is the first step of one battle action, before its targets are
    /// picked apart, so the act data still has the command, the abilities and the intended target
    /// list. The act object can be seen again if the state machine restarts; dedupe within a few
    /// frames so one action yields one battle.act.
    /// </summary>
    [HarmonyPatch(typeof(BattleActExection), nameof(BattleActExection.InitPrepareState))]
    private static class BattleActStart
    {
        private static long _lastSignature;
        private static int _lastFrame;

        private static void Postfix(BattleActExection __instance)
        {
            HookErrors.Run("BattleActStart", () =>
            {
                var act = __instance?.InStagingBattleActData;
                if (act == null)
                {
                    return;
                }
                var signature = act.Pointer.ToInt64();
                if (signature == _lastSignature && Probe.Frame - _lastFrame < 5)
                {
                    return;
                }
                _lastSignature = signature;
                _lastFrame = Probe.Frame;
                Emit.Event("battle.act", o => GameState.FillBattleAct(o, act));
            });
        }
    }

    /// <summary>
    /// 0.13.0: AddLog receives the action plus one ICalcResult per target after the effect has
    /// been calculated. That is the only place all six games expose damage/heal, miss and the
    /// status list together; it is emitted as one battle.hit per target.
    /// </summary>
    [HarmonyPatch(typeof(BattleActLog), nameof(BattleActLog.AddLog))]
    private static class BattleHit
    {
        private static void Postfix(
            BattleActData battleActData,
            Il2CppSystem.Collections.Generic.Dictionary<BattleUnitData, ICalcResult> calcResult)
        {
            HookErrors.Run("BattleHit", () => GameState.EmitBattleHits(battleActData, calcResult));
        }
    }

#if FF5
    /// <summary>
    /// 0.13.1: capture the TextAsset where the game itself gets it. InstantiateManager's
    /// argument is the monster id. The other two accessors pass a battle-unit uniqueId, which we
    /// translate through BattleEnemyData.UniqueId to the monster id before caching.
    /// </summary>
    [HarmonyPatch(typeof(InstantiateManager), nameof(InstantiateManager.GetEnemyAIScript))]
    private static class BattleAiScriptInstantiate
    {
        private static void Postfix(int __0, UnityEngine.TextAsset __result)
        {
            HookErrors.Run("BattleAiScriptInstantiate", () => AiScriptCache.RememberMonster(__0, __result));
        }
    }

    // 11-03: do not hook BattleAiExecute.SetTextAsset. A postfix there made FF5 die about
    // 10 seconds after startup with no managed exception; removing only this hook fixed it.
    // Preloaded scripts are read from already loaded objects when monsterai is queried.
    [HarmonyPatch(typeof(Last.Battle.AI.BattleAiExecute), "Last_Battle_IBattleAIAccessor_GetEnemyAIScript")]
    private static class BattleAiScriptExecute
    {
        private static void Postfix(int __0, UnityEngine.TextAsset __result)
        {
            HookErrors.Run("BattleAiScriptExecute", () => AiScriptCache.RememberUnique(__0, __result));
        }
    }

    [HarmonyPatch(typeof(EventCommand), nameof(EventCommand.GetEnemyAIScript))]
    private static class BattleAiScriptEventCommand
    {
        private static void Postfix(int __0, UnityEngine.TextAsset __result)
        {
            HookErrors.Run("BattleAiScriptEventCommand", () => AiScriptCache.RememberUnique(__0, __result));
        }
    }

    [HarmonyPatch(typeof(Last.Battle.AI.BattleAiSelectController), nameof(Last.Battle.AI.BattleAiSelectController.GetBattleAI))]
    private static class BattleAiScriptSelect
    {
        private static void Postfix(Last.Battle.AI.BattleAiSelectController __instance, UnityEngine.TextAsset __result)
        {
            HookErrors.Run("BattleAiScriptSelect", () =>
            {
                var script = __instance?.selectedMonsterAiScript;
                if (script != null)
                {
                    AiScriptCache.RememberScript(script.Id, script.ScriptName, __result);
                }
            });
        }
    }
#endif

    [HarmonyPatch(typeof(PictureBookSaveManager), nameof(PictureBookSaveManager.Registration))]
    private static class BestiaryRegister
    {
        private static void Postfix(int monsterId, int count)
        {
            Emit.Event("bestiary.register", o =>
            {
                o["monster"] = monsterId;
                o["count"] = count;
            });
        }
    }
}

/// <summary>
/// 0.13.0: postfixes must never affect the battle. Every hook body goes through here; failures
/// are counted by hook name and logged the first time (and every 100th time) as a warning.
/// </summary>
internal static class HookErrors
{
    private static readonly Dictionary<string, int> Counts = new();

    public static void Run(string name, Action body)
    {
        try
        {
            body();
        }
        catch (Exception e)
        {
            Failed(name, e);
        }
    }

    /// <summary>Counts one swallowed failure; used by the hooks and by Emit when a fill throws.</summary>
    public static void Failed(string name, Exception e)
    {
        int count;
        lock (Counts)
        {
            Counts.TryGetValue(name, out var old);
            count = old + 1;
            Counts[name] = count;
        }
        if (count == 1 || count % 100 == 0)
        {
            Plugin.Logger?.LogWarning($"挂钩 {name} 出错({count} 次):{e.GetType().Name}: {e.Message}");
        }
    }

    public static JsonObject Snapshot()
    {
        var o = new JsonObject();
        lock (Counts)
        {
            foreach (var pair in Counts)
            {
                o[pair.Key] = pair.Value;
            }
        }
        return o;
    }
}

/// <summary>Message IDs looked up since the last dialog, for pairing dialogs with their IDs.</summary>
internal static class Lookups
{
    private const int Max = 48;
    private static readonly Regex Markup = new(@"<[^>]*>|\[[^\]]*\]|\s+", RegexOptions.Compiled);
    private static readonly List<(string Key, string Text)> Recent = new();

    /// <summary>Set while the bridge itself resolves a message, so its own lookups are not kept.</summary>
    [ThreadStatic]
    public static bool Suppressed;

    public static void Add(string key, string text)
    {
        lock (Recent)
        {
            if (Recent.Count >= Max)
            {
                Recent.RemoveAt(0);
            }
            Recent.Add((key, text));
        }
    }

    /// <summary>
    /// Returns the IDs whose text shares a prefix with the dialog's first non-empty line, plus
    /// every recent ID (newest last) for offline analysis, and forgets them.
    /// </summary>
    public static (JsonArray Matched, JsonArray Recent) Take(JsonArray lines)
    {
        List<(string Key, string Text)> taken;
        lock (Recent)
        {
            taken = new List<(string, string)>(Recent);
            Recent.Clear();
        }
        var first = "";
        foreach (var line in lines ?? new JsonArray())
        {
            first = Normalize(line?.GetValue<string>());
            if (first.Length > 0)
            {
                break;
            }
        }
        var probe = first.Length > 8 ? first[..8] : first;
        var matched = new JsonArray();
        var recent = new JsonArray();
        var seen = new HashSet<string>();
        foreach (var (key, text) in taken)
        {
            recent.Add(key);
            var norm = Normalize(text);
            if (probe.Length > 0 && norm.Length > 0 && (norm.Contains(probe) || first.Contains(norm))
                && !seen.Contains(key))
            {
                seen.Add(key);
                matched.Add(key);
            }
        }
        return (matched, recent);
    }

    private static string Normalize(string s) => s == null ? "" : Markup.Replace(s, "");
}
