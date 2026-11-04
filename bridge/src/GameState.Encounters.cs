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
///
/// 0.13.6 also reports the world map's encounter regions: MapAttribute's AttributeEncount holds
/// MapAreaAttribute entries with grid number, cell bounds and their own EncountTable list. The
/// current one is the area whose bounds contain the player; `regions` lists every area the loaded
/// map model carries, each with all the monster sets it can roll.
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
        var master = Il2CppSystem.SingletonMonoBehaviour<MasterManager>.instance;
        var parties = new JsonArray();
        AppendParties(parties, set, master);
        o["parties"] = parties;
        try
        {
            var regions = Regions(controller, master);
            if (regions != null)
            {
                o["region"] = regions["current"];
                o["regions"] = regions["regions"];
            }
        }
        catch (Exception)
        {
            // Region data is extra; the current table above is still useful without it.
        }
        return o;
    }

    private static JsonObject Regions(Last.Map.FieldController controller, MasterManager master)
    {
        var model = CurrentMapModel(controller);
        var data = model?.attribute?.EncountData;
        var areas = data?.Areas;
        if (areas == null || areas.Length == 0)
        {
            return null;
        }
        var cell = controller.ConvertWorldPositionToCellPosition(
            controller.player.transform.localPosition);
        var cx = (int)Math.Round(cell.x);
        var cy = (int)Math.Round(cell.y);
        JsonObject current = null;
        var rows = new JsonArray();
        for (var i = 0; i < areas.Length; i++)
        {
            var area = areas[i];
            if (area == null)
            {
                continue;
            }
            var row = AreaNode(area, master);
            var inside =
                cx >= area.StartX && cx <= area.EndX && cy >= area.StartY && cy <= area.EndY;
            if (inside)
            {
                row["current"] = true;
                current ??= row;
            }
            rows.Add(row);
        }
        return new JsonObject { ["current"] = current, ["regions"] = rows };
    }

    private static JsonObject AreaNode(Last.Map.MapAreaAttribute area, MasterManager master)
    {
        var parties = new JsonArray();
        var list = area.EncountList;
        if (list != null)
        {
            foreach (var pair in list)
            {
                AppendParties(parties, pair.Value, master);
            }
        }
        return new JsonObject
        {
            ["grid"] = area.GridNumber,
            ["start"] = new JsonArray(area.StartX, area.StartY),
            ["end"] = new JsonArray(area.EndX, area.EndY),
            ["parties"] = parties,
        };
    }

    private static void AppendParties(JsonArray parties, object set, MasterManager master)
    {
        if (set == null)
        {
            return;
        }
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
