#if FF5
using System;
using System.Text.Json.Nodes;
using Last.Management;
using UnityEngine.UI;

namespace FfprBridge;

/// <summary>
/// FF5's game-over prompts. After a wipe or the escape countdown reaching zero the game opens
/// the "读取" window: the autosave slot plus "要从最新的保存数据开始吗？ 是 / 否". Choosing 否
/// opens "返回标题画面。可以吗？ 是 / 否". The normal dialog/title/saveui readers cannot see
/// either window, so they get their own section and query.
/// </summary>
internal static partial class GameState
{
    private static Last.UI.KeyInput.GameOverPopupController _gameOver;
    private static Last.UI.KeyInput.SaveContentController _gameOverSaveContent;

    public static JsonObject GameOver()
    {
        var c = Active(ref _gameOver);
        if (c == null)
        {
            // The controller can sit on a still-inactive object while IsOpen is being set.
            c = Il2CppSystem.SingletonMonoBehaviour<FieldGameOverPopupManager>.instance?.controller ??
                Il2CppSystem.SingletonMonoBehaviour<GameOverPopupManager>.instance?.controller;
        }
        if (c == null || !c.IsOpen)
        {
            return new JsonObject
            {
                ["open"] = false,
                ["prompt"] = null,
                ["cursor"] = null,
                ["autosave"] = null,
            };
        }
        var state = c.stateMachine?.Current.ToString();
        var load = c.view?.loadPopup;
        var common = c.commonPopup;
        string prompt = null;
        int? cursor = null;
        JsonObject autosave = null;
        if (state == "SaveLoadPopup" ||
            (state != "BackTitlePopup" && state != "CommandSelect" && Shown(load)))
        {
            // 推断，待真机核对: 这个状态就是「读取」+ 自动保存栏 + 要从最新的保存数据开始吗。
            prompt = "continue";
            cursor = CursorIndex(load?.selectCursor);
            autosave = AutoSave(load, c.saveData);
        }
        else if (state == "BackTitlePopup" || Shown(common))
        {
            // 推断，待真机核对: 这个状态就是「返回标题画面。可以吗？」。
            prompt = "to-title";
            cursor = CursorIndex(common?.selectCursor);
        }
        else if (state == "CommandSelect")
        {
            // 还没核对 CommandSelect 问的是继续还是返回标题（FF5 真机没见过），只给光标。
            cursor = CursorIndex(c.selectPopup?.selectCursor);
        }
        return new JsonObject
        {
            ["open"] = true,
            ["prompt"] = prompt,
            ["cursor"] = cursor,
            ["autosave"] = autosave,
        };
    }

    private static int? CursorIndex(Last.UI.Cursor cursor)
    {
        try
        {
            return cursor?.Index;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// The autosave row as shown: label 自动保存, map 卡纳克城 1 层, time 2026/11/10 1:48.
    /// The texts come from the row itself (not from SaveSlotData keys) so they match the screen.
    /// </summary>
    private static JsonObject AutoSave(Last.UI.KeyInput.GameOverLoadPopup load, SaveSlotData fallback)
    {
        try
        {
            // 0.14.4: IsExistData is not reliable for the auto-save row (the game can fill it
            // through SetInterruptionData instead of SetData), so read the row itself first and
            // only use IsExistData as a hint. The old early return made autosave always null.
            var content = load?.saveContentController ?? Active(ref _gameOverSaveContent);
            var view = content?.view;
            var data = content?.SlotData ?? fallback;
            var map = Join(TextOf(view?.areaNameText), TextOf(view?.floorNameText));
            var label = TextOf(view?.slotNameText) ?? Plain(content?.slotName);
            var time = Join(TextOf(view?.timeStampDate), TextOf(view?.timeStampTime));
            if (map == null && data != null)
            {
                // 推断，待真机核对: 画面上读不到时退回存档数据。GetLocationTextBySaveData is the
                // game's own formatter for the same 卡纳克城 2 层 line; if it is unavailable,
                // CurrentArea + CurrentLocation are the two fields behind it.
                map = LocationText(content, data) ??
                    Join(Plain(data.CurrentArea), Plain(data.CurrentLocation));
            }
            if (time == null && data != null)
            {
                time = Plain(data.TimeStamp);
            }
            if (map == null && label == null && time == null)
            {
                return null;
            }
            return new JsonObject
            {
                ["map"] = map,
                ["label"] = label,
                ["time"] = time,
            };
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>The row's location text as the game formats it; null when unavailable.</summary>
    private static string LocationText(
        Last.UI.KeyInput.SaveContentController content, SaveSlotData data)
    {
        try
        {
            var value = content?.GetLocationTextBySaveData(data);
            return string.IsNullOrEmpty(value) ? null : value.Trim();
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>A text field that may be a message key; keeps a literal string as-is.</summary>
    private static string Plain(string text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return null;
        }
        var resolved = Text(text);
        return string.IsNullOrEmpty(resolved) ? text.Trim() : resolved;
    }

    private static string TextOf(Text text)
    {
        try
        {
            var value = text?.text;
            return string.IsNullOrEmpty(value) ? null : value.Trim();
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static string Join(string first, string second)
    {
        if (string.IsNullOrEmpty(first))
        {
            return string.IsNullOrEmpty(second) ? null : second;
        }
        return string.IsNullOrEmpty(second) ? first : first + " " + second;
    }
}
#endif
