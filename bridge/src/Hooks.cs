using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using HarmonyLib;
using Il2CppInterop.Runtime.InteropTypes.Arrays;
using Last.Management;
using Last.Message;

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
