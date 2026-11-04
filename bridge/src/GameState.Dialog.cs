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

/// <summary>Dialog and choice windows.</summary>
internal static partial class GameState
{
    private static JsonNode Dialog()
    {
        var m = Singleton.instance;
        if (m == null)
        {
            return null;
        }
        return new JsonObject
        {
            ["open"] = m.IsOpen(),
            ["playing"] = m.isPlaying,
            ["field"] = m.isFieldWindow,
            ["page"] = m.currentPageNumber,
            ["waitPage"] = m.IsNewPageInputWaiting(),
            ["waitEnd"] = m.IsEndWaiting(),
            ["speaker"] = m.spekerValue,
            ["lines"] = Strings(m.messageList),
        };
    }

    private static JsonNode Choice()
    {
        var select = Il2CppSystem.SingletonMonoBehaviour<MessageSelectWindowManager>.instance;
        var multiple = Il2CppSystem.SingletonMonoBehaviour<MessageChoiceWindowManager>.instance;
        var o = new JsonObject();
        if (select != null)
        {
            var c = select.controller;
            o["select"] = new JsonObject
            {
                ["open"] = select.isOpen,
                ["default"] = select.defaultIndex,
                ["options"] = Strings(select.messageList),
                // System yes/no prompts leave messageList empty; the labels are on screen.
                ["labels"] = Labels(c?.contentList),
                ["cursor"] = c?.selectCursor?.Index,
            };
        }
        if (multiple != null)
        {
            var c = multiple.controller;
            o["multiple"] = new JsonObject
            {
                ["open"] = multiple.isOpen,
                ["options"] = Strings(multiple.messageList),
                ["labels"] = Labels(c?.contentList),
                ["cursor"] = c?.selectCursor?.Index,
            };
        }
        return o;
    }

    /// <summary>Labels of the select or multiple choice window, for the choice.open event.</summary>
    public static JsonNode ChoiceLabels(string kind)
    {
        var labels = Choice()?.AsObject()?[kind]?["labels"];
        // A node can belong to one parent only; .NET 6 has no DeepCopy, so reparse it.
        return labels == null ? null : JsonNode.Parse(labels.ToJsonString());
    }

    /// <summary>The text shown on each option of a choice window.</summary>
    private static JsonArray Labels(Il2CppSystem.Collections.Generic.List<Last.UI.KeyInput.MessageSelectContentController> list)
    {
        if (list == null)
        {
            return null;
        }
        var labels = new JsonArray();
        for (var i = 0; i < list.Count; i++)
        {
            var item = list[i];
            if (item == null || !item.gameObject.activeInHierarchy)
            {
                continue;
            }
            labels.Add(item.view?.text?.text);
        }
        return labels;
    }
}
