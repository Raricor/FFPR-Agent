using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using Il2CppInterop.Runtime;
using Last.Battle;
using Last.Management;
using Last.Message;
using UnityEngine;
using Singleton = Il2CppSystem.SingletonMonoBehaviour<Last.Message.MessageWindowManager>;

namespace FfprBridge;

/// <summary>
/// Reads one snapshot of the game state. Each section is read on its own so that one broken
/// read (a class renamed in another game or build) still leaves the others in the record.
/// Singletons are read through their backing fields, never through accessors that might
/// create the instance.
/// </summary>
internal static partial class GameState
{
    private static readonly Dictionary<string, string> MessageCache = new();

    public static void Fill(JsonObject o)
    {
        Section(o, "scene", Scene);
        Section(o, "user", User);
        Section(o, "party", Party);
        Section(o, "field", Field);
        Section(o, "dialog", Dialog);
        Section(o, "choice", Choice);
        Section(o, "battle", Battle);
    }

    private static void Section(JsonObject o, string key, Func<JsonNode> read)
    {
        try
        {
            o[key] = read();
        }
        catch (Exception e)
        {
            o[key] = new JsonObject { ["error"] = $"{e.GetType().Name}: {e.Message}" };
        }
    }

    /// <summary>Main-game state (Player, Message, Event, Battle, Menu, Shop …), or null outside it.</summary>
    public static string MainState()
    {
        var sub = SceneManager.instance?.GetCurrentSubSceneManager();
        return sub?.TryCast<SubSceneManagerMainGame>()?.GetCurrentState().ToString();
    }

    private static JsonNode Scene()
    {
        var manager = SceneManager.instance;
        if (manager == null)
        {
            return null;
        }
        var o = new JsonObject { ["name"] = manager.currentSceneName };
        var sub = manager.GetCurrentSubSceneManager();
        if (sub != null)
        {
            o["sub"] = sub.GetIl2CppType().Name;
            o["state"] = sub.TryCast<SubSceneManagerMainGame>()?.GetCurrentState().ToString();
        }
        return o;
    }

    private static JsonNode User()
    {
        var u = UserDataManager.instance;
        if (u == null)
        {
            return null;
        }
        var o = new JsonObject
        {
            ["mapId"] = u.CurrentMapId,
            ["areaId"] = u.CurrentAreaId,
            ["areaType"] = u.CurrentAreaType,
            ["area"] = u.CurrentArea,
            ["areaText"] = Text(u.CurrentArea),
            ["location"] = u.CurrentLocation,
            ["locationText"] = Text(u.CurrentLocation),
            ["gil"] = u.OwendGil,
#if !(FF1 || FF2 || FF3)
            // 10-28: FF1-FF3 keep no total gil, and only FF5 counts wins.
            ["totalGil"] = u.TotalGil,
#endif
            ["playTime"] = Math.Round(u.PlayTime, 1),
            ["steps"] = u.Steps,
            ["battles"] = u.BattleCount,
#if FF5
            ["wins"] = u.WinCount,
#endif
            ["escapes"] = u.EscapeCount,
            ["kills"] = u.MonstersKilledCount,
            ["chests"] = u.OpenChestCount,
            ["saves"] = u.SaveCompleteCount,
            ["complete"] = u.IsGameCompleteFlag,
        };
        var boost = u.CheatSettingsData;
        if (boost != null)
        {
            o["boost"] = new JsonObject
            {
                ["encounter"] = boost.IsEnableEncount,
                ["exp"] = boost.ExpRate,
                ["gil"] = boost.GilRate,
                ["abp"] = boost.AbpRate,
            };
        }
        return o;
    }

    private static T Active<T>(ref T cached) where T : UnityEngine.Component
    {
        // 10-27: a scene can hold several instances of one controller. The cache used to keep
        // the first one found for good, so when the battle target cursor came back as another
        // instance, `target` read null while the cursor was on screen and enemy aiming was blind.
        try
        {
            if (cached != null && cached.gameObject.activeInHierarchy)
            {
                return cached;
            }
        }
        catch (Exception)
        {
            cached = null; // destroyed with its scene
        }
        // FindObjectsOfType only returns active objects; search at most every 0.2 s per type.
        var type = typeof(T);
        if (LastSearch.TryGetValue(type, out var last) && Time.unscaledTime - last < 0.2f)
        {
            return null;
        }
        LastSearch[type] = Time.unscaledTime;
        var found = UnityEngine.Object.FindObjectsOfType(Il2CppType.Of<T>());
        for (var i = 0; found != null && i < found.Length; i++)
        {
            var item = found[i]?.TryCast<T>();
            if (item != null && item.gameObject.activeInHierarchy)
            {
                cached = item;
                return item;
            }
        }
        return null;
    }

    private static readonly Dictionary<Type, float> LastSearch = new();

    /// <summary>Resolves a message key (MSG_MAP_NAME_07) to its text, without polluting Lookups.</summary>
    public static string Text(string key)
    {
        if (string.IsNullOrEmpty(key))
        {
            return null;
        }
        if (MessageCache.TryGetValue(key, out var cached))
        {
            return cached;
        }
        var messages = Il2CppSystem.SingletonMonoBehaviour<MessageManager>.instance;
        if (messages == null)
        {
            return null;
        }
        string text;
        Lookups.Suppressed = true;
        try
        {
            text = messages.GetMessage(key, true);
        }
        finally
        {
            Lookups.Suppressed = false;
        }
        MessageCache[key] = text;
        return text;
    }

    public static JsonArray Strings(Il2CppSystem.Collections.Generic.List<string> list, int max = 32)
    {
        if (list == null)
        {
            return null;
        }
        var array = new JsonArray();
        for (var i = 0; i < list.Count && i < max; i++)
        {
            array.Add(list[i]);
        }
        return array;
    }

    private static JsonArray Vec(Vector3 v) => new(Round(v.x), Round(v.y), Round(v.z));

    private static JsonArray Vec(Vector2 v) => new(Round(v.x), Round(v.y));

    private static JsonNode Round(float f) => Math.Round(f, 2);
}
