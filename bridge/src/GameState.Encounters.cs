using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using Il2CppInterop.Runtime.InteropTypes.Arrays;
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
///
/// 0.13.7 adds `enabled` (the story-controlled map switch), `vehicle` (the current transportation)
/// and `map`: every party the map can roll, not only the party under the player's feet.
/// 0.13.8 scans every cell for towns/dungeons and finds the world-map region by grid number.
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
            AddEncounterFields(o, controller, master);
        }
        catch (Exception)
        {
            // The 0.13.7 extras must never hide monsterSet/parties.
        }
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

    /// <summary>
    /// 0.13.7: the three extra fields. Each one is read on its own so a class that moved in
    /// another game can leave just that field null or empty; the old fields above stay intact.
    /// </summary>
    private static void AddEncounterFields(
        JsonObject o,
        Last.Map.FieldController controller,
        MasterManager master)
    {
        o["enabled"] = EncountEnabled();
        o["vehicle"] = Vehicle(controller);
        o["map"] = MapEncounters(controller, master);
    }

    /// <summary>SaveMapData.EncountEnable, the switch the story script sets.</summary>
    private static bool? EncountEnabled()
    {
        try
        {
            var save = Last.Map.SaveMapManager.Instance?.SaveData;
            return save == null ? null : save.EncountEnable;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// The transportation the player is on now. TransportationController.CurrentTransportation
    /// and Transportation.GetPlayer are the game's own lookups; the saved id and currentTransport
    /// field are fallbacks. Null on foot or when the info cannot be read.
    /// </summary>
    private static JsonObject Vehicle(Last.Map.FieldController controller)
    {
        try
        {
            var transport = controller?.transportation;
            if (transport == null)
            {
                return null;
            }
            Last.Map.TransportationInfo info = null;
            try
            {
                var current = transport.CurrentTransportation;
                if (current != null && current.Id > 0)
                {
                    info = current;
                }
            }
            catch (Exception)
            {
                // Fall through to the other lookups.
            }
            if (info == null)
            {
                try
                {
                    var player = transport.infoData?.GetPlayer();
                    if (player != null && player.Id > 0)
                    {
                        info = player;
                    }
                }
                catch (Exception)
                {
                    // Fall through to the saved id.
                }
            }
            if (info == null)
            {
                var savedId = 0;
                try
                {
                    savedId = Last.Map.SaveMapManager.Instance?.SaveData?.TransportationId ?? 0;
                }
                catch (Exception)
                {
                    savedId = 0;
                }
                if (savedId > 0)
                {
                    try
                    {
                        info = transport.infoData?.GetInfoDataAllSearches(savedId);
                    }
                    catch (Exception)
                    {
                        info = null;
                    }
                    if (info == null)
                    {
                        var fallback = transport.currentTransport;
                        if (fallback != null && fallback.Id > 0)
                        {
                            info = fallback;
                        }
                    }
                }
            }
            if (info == null)
            {
                return null;
            }
            return new JsonObject { ["id"] = info.Id, ["encounter"] = info.EncountFlag };
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// Every party this map can roll, not just the cell underfoot. Towns and dungeons use the
    /// current EncountTable array for the whole map; the world map computes the player cell's grid
    /// number from EncountGridData and picks the MapAreaAttribute with that GridNumber, then
    /// merges all of that area's terrain tables. Parties are deduplicated by party id. Read only.
    /// </summary>
    private static JsonObject MapEncounters(
        Last.Map.FieldController controller,
        MasterManager master)
    {
        var o = new JsonObject { ["scope"] = "map" };
        var grids = new List<int>();
        var seenGrids = new HashSet<int>();
        var parties = new JsonArray();
        var seenParties = new HashSet<int>();
        var seenSets = new HashSet<int>();
        string error = null;
        try
        {
            var model = CurrentMapModel(controller);
            var encount = model?.attribute?.EncountData;
            Last.Map.EncountGridData gridData = null;
            if (model != null)
            {
                gridData = EncounterGridData(model.assetData);
            }
            if (model == null)
            {
                error = "no map encounter data";
            }
            else if (AreaScope(encount))
            {
                o["scope"] = "area";
                error = AppendArea(controller, encount, gridData, master, grids, parties, seenParties, seenSets);
            }
            else
            {
                var debug = new JsonObject();
                o["debug"] = debug;
                error = AppendWholeMap(
                    controller, model, gridData, master, grids, seenGrids,
                    parties, seenParties, seenSets, debug);
            }
        }
        catch (Exception)
        {
            grids.Clear();
            parties = new JsonArray();
            error = "cannot read map encounter data";
        }
        grids.Sort();
        var gridArray = new JsonArray();
        foreach (var grid in grids)
        {
            gridArray.Add(grid);
        }
        o["grids"] = gridArray;
        o["parties"] = parties;
        if (!string.IsNullOrEmpty(error))
        {
            o["error"] = error;
        }
        return o;
    }

    /// <summary>
    /// 0.13.8 query: the encounter grid number at up to 64 requested cells. Null when the cell
    /// is outside EncountGridData or the map has no grid data. Used to test whether a step leaves
    /// the world map's current region.
    /// </summary>
    public static JsonArray EncountGrids(JsonArray cells)
    {
        var result = new JsonArray();
        if (cells == null)
        {
            return result;
        }
        Last.Map.EncountGridData gridData = null;
        Last.Map.AttributeEncount encount = null;
        try
        {
            if (TryPlayer(out var controller, out _))
            {
                var model = CurrentMapModel(controller);
                if (model != null)
                {
                    gridData = EncounterGridData(model.assetData);
                    encount = model.attribute?.EncountData;
                }
            }
        }
        catch (Exception)
        {
            // Every requested cell stays null.
        }
        var max = Math.Min(cells.Count, 64);
        for (var i = 0; i < max; i++)
        {
            int? grid = null;
            try
            {
                var pair = cells[i]?.AsArray();
                if (pair != null && pair.Count >= 2)
                {
                    var x = pair[0].GetValue<int>();
                    var y = pair[1].GetValue<int>();
                    grid = RegionGrid(gridData, encount, x, y);
                }
            }
            catch (Exception)
            {
                grid = null;
            }
            result.Add(grid);
        }
        return result;
    }

    /// <summary>
    /// Prefer the y*Width+x candidate that names a real MapAreaAttribute; if only the flipped
    /// one matches, report that one so this query agrees with the current-region lookup.
    /// </summary>
    private static int? RegionGrid(
        Last.Map.EncountGridData gridData,
        Last.Map.AttributeEncount encount,
        int x,
        int y)
    {
        var primary = GridAt(gridData, x, y, false);
        var flipped = GridAt(gridData, x, y, true);
        if (GridMatches(encount, primary))
        {
            return primary;
        }
        if (GridMatches(encount, flipped))
        {
            return flipped;
        }
        return primary ?? flipped;
    }

    private static bool GridMatches(Last.Map.AttributeEncount encount, int? grid)
    {
        if (encount == null || grid == null)
        {
            return false;
        }
        return AreaByGrid(AreasOf(encount, false), grid) != null ||
            AreaByGrid(AreasOf(encount, true), grid) != null;
    }

    private static bool AreaScope(Last.Map.AttributeEncount encount)
    {
        // MapAreaAttribute is the world map's area list; ordinary maps carry EncountCells only.
        return AreaCount(AreasOf(encount, false)) > 0 || AreaCount(AreasOf(encount, true)) > 0;
    }

    private static Il2CppReferenceArray<Last.Map.MapAreaAttribute> AreasOf(
        Last.Map.AttributeEncount encount,
        bool defaults)
    {
        if (encount == null)
        {
            return null;
        }
        try
        {
            return defaults ? encount.defaultAreas : encount.Areas;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static int AreaCount(Il2CppReferenceArray<Last.Map.MapAreaAttribute> areas)
    {
        try
        {
            return areas?.Length ?? 0;
        }
        catch (Exception)
        {
            return 0;
        }
    }

    private static Last.Map.MapAreaAttribute AreaByGrid(
        Il2CppReferenceArray<Last.Map.MapAreaAttribute> areas,
        int? grid)
    {
        if (areas == null || grid == null)
        {
            return null;
        }
        try
        {
            var count = areas.Length;
            for (var i = 0; i < count; i++)
            {
                var area = areas[i];
                if (area != null && area.GridNumber == grid.Value)
                {
                    return area;
                }
            }
        }
        catch (Exception)
        {
            // Try the other list / the bounds fallback.
        }
        return null;
    }

    private static Last.Map.MapAreaAttribute AreaByBounds(
        Il2CppReferenceArray<Last.Map.MapAreaAttribute> areas,
        int cx,
        int cy)
    {
        if (areas == null)
        {
            return null;
        }
        try
        {
            var count = areas.Length;
            for (var i = 0; i < count; i++)
            {
                var area = areas[i];
                if (area != null &&
                    cx >= area.StartX && cx <= area.EndX &&
                    cy >= area.StartY && cy <= area.EndY)
                {
                    return area;
                }
            }
        }
        catch (Exception)
        {
            // Try the other list.
        }
        return null;
    }

    /// <summary>
    /// 0.13.7 fix: the area bounds in MapAreaAttribute are not in player-cell coordinates.
    /// Compute the player cell's grid number from EncountGridData.Cells first and match that
    /// number to MapAreaAttribute.GridNumber; both y orientations are tried. Bounds are only a
    /// fallback, and using them leaves an error for the caller to see.
    /// </summary>
    private static Last.Map.MapAreaAttribute FindCurrentArea(
        Last.Map.FieldController controller,
        Last.Map.AttributeEncount encount,
        Last.Map.EncountGridData gridData,
        out string error)
    {
        error = null;
        var areas = AreasOf(encount, false);
        var defaults = AreasOf(encount, true);
        if (AreaCount(areas) == 0 && AreaCount(defaults) == 0)
        {
            error = "no encounter areas on this map";
            return null;
        }
        if (!TryCellInfo(controller, gridData, out var cx, out var cy, out var grid, out var flipped))
        {
            error = "no player cell";
            return null;
        }
        var current =
            AreaByGrid(areas, grid) ??
            AreaByGrid(areas, flipped) ??
            AreaByGrid(defaults, grid) ??
            AreaByGrid(defaults, flipped);
        if (current != null)
        {
            return current;
        }
        current = AreaByBounds(areas, cx, cy) ?? AreaByBounds(defaults, cx, cy);
        if (current == null)
        {
            error = "no encounter area at player cell";
            return null;
        }
        error = gridData == null
            ? "no encounter grid data; used area bounds"
            : "no encounter grid match; used area bounds";
        return current;
    }

    private static bool TryCellInfo(
        Last.Map.FieldController controller,
        Last.Map.EncountGridData gridData,
        out int cx,
        out int cy,
        out int? cellGrid,
        out int? cellGridFlipped)
    {
        cx = 0;
        cy = 0;
        cellGrid = null;
        cellGridFlipped = null;
        try
        {
            var cell = controller.ConvertWorldPositionToCellPosition(
                controller.player.transform.localPosition);
            cx = (int)Math.Round(cell.x);
            cy = (int)Math.Round(cell.y);
            cellGrid = GridAt(gridData, cx, cy, false);
            cellGridFlipped = GridAt(gridData, cx, cy, true);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static int? GridAt(
        Last.Map.EncountGridData gridData,
        int x,
        int y,
        bool flipY)
    {
        if (gridData == null)
        {
            return null;
        }
        try
        {
            var width = gridData.Width;
            var height = gridData.Height;
            var cells = gridData.Cells;
            if (cells == null || width <= 0 || height <= 0)
            {
                return null;
            }
            var row = flipY ? height - 1 - y : y;
            if (x < 0 || x >= width || row < 0 || row >= height)
            {
                return null;
            }
            var index = row * width + x;
            if (index < 0 || index >= cells.Length)
            {
                return null;
            }
            return cells[index];
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>The current world-map area: its grid number and every terrain table it carries.</summary>
    private static string AppendArea(
        Last.Map.FieldController controller,
        Last.Map.AttributeEncount encount,
        Last.Map.EncountGridData gridData,
        MasterManager master,
        List<int> grids,
        JsonArray parties,
        HashSet<int> seenParties,
        HashSet<int> seenSets)
    {
        var current = FindCurrentArea(controller, encount, gridData, out var error);
        if (current == null)
        {
            return error;
        }
        grids.Add(current.GridNumber);
        var list = current.EncountList;
        if (list != null)
        {
            foreach (var pair in list)
            {
                AppendTable(parties, pair.Value, master, seenSets, seenParties);
            }
        }
        return error;
    }

    /// <summary>
    /// 0.13.8: towns and dungeons have no AttributeEncount, so ask the game once for every cell
    /// in every collision layer and keep the distinct MonsterSet ids. The result is cached by map
    /// id and invalidated by MapWatch on a map change.
    /// </summary>
    private static string AppendWholeMap(
        Last.Map.FieldController controller,
        Last.Map.MapModel model,
        Last.Map.EncountGridData gridData,
        MasterManager master,
        List<int> grids,
        HashSet<int> seenGrids,
        JsonArray parties,
        HashSet<int> seenParties,
        HashSet<int> seenSets,
        JsonObject debug)
    {
        var scan = GetMapScan(controller, model, gridData);
        for (var i = 0; i < scan.Grids.Length; i++)
        {
            AddGrid(grids, seenGrids, scan.Grids[i]);
        }
        for (var i = 0; i < scan.SetIds.Length; i++)
        {
            var id = scan.SetIds[i];
            if (seenSets.Add(id))
            {
                AppendSet(parties, id, master, seenParties);
            }
        }
        var ids = new JsonArray();
        for (var i = 0; i < scan.SetIds.Length; i++)
        {
            ids.Add(scan.SetIds[i]);
        }
        debug["cellsScanned"] = scan.CellsScanned;
        debug["layers"] = scan.Layers;
        debug["setIds"] = ids;
        return scan.Error;
    }

    private sealed class MapScan
    {
        public int MapId;
        public int CellsScanned;
        public int Layers;
        public int[] Grids;
        public int[] SetIds;
        public string Error;
    }

    private static MapScan _mapScan;

    /// <summary>Called by MapWatch when the current map changes.</summary>
    public static void InvalidateEncountCache()
    {
        _mapScan = null;
    }

    private static MapScan GetMapScan(
        Last.Map.FieldController controller,
        Last.Map.MapModel model,
        Last.Map.EncountGridData gridData)
    {
        var mapId = Last.Management.UserDataManager.instance?.CurrentMapId ?? -1;
        if (_mapScan != null && _mapScan.MapId == mapId)
        {
            return _mapScan;
        }
        var scan = ScanMap(controller, model, gridData, mapId);
        if (scan.Error == null || scan.CellsScanned > 0)
        {
            _mapScan = scan;
        }
        return scan;
    }

    private static MapScan ScanMap(
        Last.Map.FieldController controller,
        Last.Map.MapModel model,
        Last.Map.EncountGridData gridData,
        int mapId)
    {
        var scan = new MapScan
        {
            MapId = mapId,
            Grids = new int[0],
            SetIds = new int[0],
        };
        var grids = new List<int>();
        AddGrids(gridData, grids, new HashSet<int>());
        scan.Grids = grids.ToArray();

        var scanModel = controller.mapManager?.currentMapModel ?? model;
        var group = scanModel?.AssetData?.CollsionInfo?.CollisionMap;
        if (group == null)
        {
            scan.Error = "no collision map";
            return scan;
        }
        var layers = group.layers;
        var layerCount = layers == null || layers.Length == 0 ? 1 : layers.Length;
        scan.Layers = layerCount;
        var setIds = new HashSet<int>();
        var setList = new List<int>();
        var cells = 0;
        var failed = 0;
        for (var layerIndex = 0; layerIndex < layerCount; layerIndex++)
        {
            var layer = layers != null && layers.Length > 0 ? layers[layerIndex] : null;
            var width = layer != null ? layer.width : 0;
            var height = layer != null ? layer.height : 0;
            if (width <= 0)
            {
                width = group.width;
            }
            if (height <= 0)
            {
                height = group.height;
            }
            if (width <= 0 || height <= 0)
            {
                failed++;
                continue;
            }
            for (var y = 0; y < height; y++)
            {
                for (var x = 0; x < width; x++)
                {
                    cells++;
                    try
                    {
                        // Let the game apply its non-encounter objects/areas, as the field does.
                        var info = CellEncountInfo(controller, x, y, layerIndex);
                        var table = info?.Table;
                        if (table == null)
                        {
                            continue;
                        }
                        var id = table.MonsterSetId;
                        if (id > 0 && setIds.Add(id))
                        {
                            setList.Add(id);
                        }
                    }
                    catch (Exception)
                    {
                        failed++;
                    }
                }
            }
        }
        scan.CellsScanned = cells;
        scan.SetIds = setList.ToArray();
        if (cells == 0)
        {
            scan.Error = "no cells to scan";
        }
        else if (failed >= cells || (failed > 0 && setList.Count == 0))
        {
            scan.Error = "encounter scan failed";
        }
        return scan;
    }

    private static void AddGrids(
        Last.Map.EncountGridData gridData,
        List<int> grids,
        HashSet<int> seen)
    {
        if (gridData == null)
        {
            return;
        }
        try
        {
            var unique = gridData.UniqueGridNumber;
            if (unique != null)
            {
                for (var i = 0; i < unique.Length; i++)
                {
                    AddGrid(grids, seen, unique[i]);
                }
            }
            if (grids.Count == 0)
            {
                var cells = gridData.Cells;
                if (cells != null)
                {
                    for (var i = 0; i < cells.Length; i++)
                    {
                        AddGrid(grids, seen, cells[i]);
                    }
                }
            }
        }
        catch (Exception)
        {
            // Keep whatever grid numbers were read before the bad call.
        }
    }

    private static void AppendSet(
        JsonArray parties,
        int id,
        MasterManager master,
        HashSet<int> seenParties)
    {
        if (id <= 0 || master == null)
        {
            return;
        }
        Last.Data.Master.MonsterSet set;
        try
        {
            set = master.GetData<Last.Data.Master.MonsterSet>(id);
        }
        catch (Exception)
        {
            return;
        }
        AppendParties(parties, set, master, seenParties);
    }

    private static void AddGrid(List<int> grids, HashSet<int> seen, int grid)
    {
        if (grid >= 0 && seen.Add(grid))
        {
            grids.Add(grid);
        }
    }

    private static Last.Map.EncountGridData EncounterGridData(Last.Map.MapAssetData asset)
    {
        if (asset == null)
        {
            return null;
        }
        try
        {
            var data = asset.EncountGridData;
            if (data != null)
            {
                return data;
            }
        }
        catch (Exception)
        {
            // Try the alternate list below.
        }
        try
        {
            var list = asset.GetEncountGridDataList();
            if (list != null)
            {
                foreach (var pair in list)
                {
                    if (pair.Value != null)
                    {
                        return pair.Value;
                    }
                }
            }
        }
        catch (Exception)
        {
            // The default above is enough when this alternate list is unavailable.
        }
        return null;
    }

    /// <summary>
    /// One EncountTable is one MonsterSet (its MonsterSetId). Resolve the master row once and let
    /// AppendParties emit the same party rows the current table uses.
    /// </summary>
    private static void AppendTable(
        JsonArray parties,
        Last.Map.EncountTable table,
        MasterManager master,
        HashSet<int> sets,
        HashSet<int> seenParties)
    {
        if (table == null || master == null)
        {
            return;
        }
        int id;
        try
        {
            id = table.MonsterSetId;
        }
        catch (Exception)
        {
            return;
        }
        if (id <= 0 || !sets.Add(id))
        {
            return;
        }
        AppendSet(parties, id, master, seenParties);
    }

    /// <summary>
    /// The game's own encounter table for one cell. Only FF5's FieldController has the
    /// per-cell overload (11-05 build: FF1–FF4 and FF6 only take a FieldEntity). Elsewhere every
    /// cell counts as a failed lookup, so `map.error` is set instead of an empty union that would
    /// read as "no encounters".
    /// </summary>
    private static Last.Map.EncountInfo CellEncountInfo(
        Last.Map.FieldController controller,
        int x,
        int y,
        int layer)
    {
#if FF5
        // Let the game apply its non-encounter objects/areas, as the field does.
        return controller.GetEncountInfo(new UnityEngine.Vector3(x, y, layer), true);
#else
        throw new NotSupportedException("no per-cell encounter lookup in this game");
#endif
    }

    private static JsonObject Regions(Last.Map.FieldController controller, MasterManager master)
    {
        var model = CurrentMapModel(controller);
        var data = model?.attribute?.EncountData;
        var areas = data?.Areas;
        var rows = new JsonArray();
        if (areas != null)
        {
            var cell = controller.ConvertWorldPositionToCellPosition(
                controller.player.transform.localPosition);
            var cx = (int)Math.Round(cell.x);
            var cy = (int)Math.Round(cell.y);
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
                }
                rows.Add(row);
            }
        }
        var current = CurrentRegion(controller, model, data, master);
        if ((areas == null || areas.Length == 0) && current == null)
        {
            return null;
        }
        return new JsonObject { ["current"] = current, ["regions"] = rows };
    }

    /// <summary>
    /// 0.13.8: the world-map region at the player, found by the same grid number as map.scope,
    /// not by StartX/EndX (the live world-map areas report all four bounds as 0).
    /// </summary>
    private static JsonObject CurrentRegion(
        Last.Map.FieldController controller,
        Last.Map.MapModel model,
        Last.Map.AttributeEncount data,
        MasterManager master)
    {
        if (data == null || model == null)
        {
            return null;
        }
        var gridData = EncounterGridData(model.assetData);
        if (!TryCellInfo(controller, gridData, out _, out _, out var grid, out var flipped))
        {
            return null;
        }
        var area =
            AreaByGrid(AreasOf(data, false), grid) ??
            AreaByGrid(AreasOf(data, false), flipped) ??
            AreaByGrid(AreasOf(data, true), grid) ??
            AreaByGrid(AreasOf(data, true), flipped);
        if (area == null)
        {
            return null;
        }
        var row = AreaNode(area, master);
        if (area.StartX == 0 && area.StartY == 0 && area.EndX == 0 && area.EndY == 0)
        {
            row["start"] = null;
            row["end"] = null;
        }
        row["current"] = true;
        return row;
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

    private static void AppendParties(
        JsonArray parties,
        object set,
        MasterManager master,
        HashSet<int> seen = null)
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
            if (seen != null && !seen.Add(id.Value))
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
