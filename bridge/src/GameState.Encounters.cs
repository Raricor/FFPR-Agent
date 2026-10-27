using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using MasterManager = Last.Data.Master.MasterManager;

namespace FfprBridge;

/// <summary>
/// What can attack at the player's position: the game's own current MonsterSet (on the world
/// map it depends on the grid area and the terrain underfoot), each party in it with its rate,
/// and the monsters of that party. Read only: GetCurrentEncountMonsterset is the getter the
/// field uses; no encounter is rolled.
/// </summary>
internal static partial class GameState
{
    public static JsonObject Encounters()
    {
        if (!TryPlayer(out var controller, out _))
        {
            return null;
        }
        var set = new Last.Map.IMapAccessor(controller.Pointer).GetCurrentEncountMonsterset();
        var o = new JsonObject { ["monsterSet"] = set?.Id };
        if (set == null)
        {
            o["parties"] = new JsonArray();
            return o;
        }
        var master = Il2CppSystem.SingletonMonoBehaviour<MasterManager>.instance;
        var parties = new JsonArray();
        for (var i = 1; i <= 16; i++)
        {
            var id = IntProperty(set, $"MonsterSet{i}");
            if (id is null or 0)
            {
                continue;
            }
            var row = new JsonObject
            {
                ["id"] = id,
                ["rate"] = IntProperty(set, $"MonsterSet{i}Rate"),
            };
            try
            {
                var party = master?.GetData<Last.Data.Master.MonsterParty>(id.Value);
                row["notEscape"] = party == null ? null : party.NotEscape != 0;
                row["monsters"] = party == null ? null : PartyMonsters(master, party);
            }
            catch (Exception)
            {
                row["monsters"] = null;
            }
            parties.Add(row);
        }
        o["parties"] = parties;
        return o;
    }

    /// <summary>The party's monsters in slot order, with the bestiary number when known.</summary>
    private static JsonArray PartyMonsters(MasterManager master, Last.Data.Master.MonsterParty party)
    {
        var monsters = new JsonArray();
        for (var slot = 1; slot <= 9; slot++)
        {
            var id = IntProperty(party, $"Monster{slot}");
            if (id is null or 0)
            {
                continue;
            }
            Last.Data.Master.Monster monster = null;
            try
            {
                monster = master.GetData<Last.Data.Master.Monster>(id.Value);
            }
            catch (Exception)
            {
                // A missing master row still reports the id.
            }
            monsters.Add(new JsonObject
            {
                ["id"] = id,
                ["name"] = monster == null ? null : Text(monster.MesIdName),
                ["book"] = BookNumber(id.Value),
            });
        }
        return monsters;
    }

    /// <summary>MonsterSet1..16 and Monster1..9 are numbered properties on the interop proxies.</summary>
    private static int? IntProperty(object target, string name)
    {
        try
        {
            return target.GetType().GetProperty(name)?.GetValue(target) as int?;
        }
        catch (Exception)
        {
            return null;
        }
    }
}
