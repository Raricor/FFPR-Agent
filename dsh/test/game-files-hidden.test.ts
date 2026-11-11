import assert from "node:assert/strict";
import test from "node:test";
import {
  parseGameMapFile,
  parseHiddenItems,
  parseMonsterRewards,
  parseScriptHiddenItems,
  parseSubmap,
  type MapResource,
} from "../src/engine/knowledge/game-files.ts";

const MAP: MapResource = {
  id: 30,
  name: "Map_92010",
  assetName: "map_92010",
  packageName: "Map_92010",
  titleKey: null,
  areaId: 9,
  saveAvailable: true,
  monsterSetId: 0,
  encountAreaGridId: 0,
};

function entity(): unknown {
  return {
    layers: [
      {
        objects: [
          {
            gid: 1,
            x: 10 * 16,
            y: (5 + 1) * 16,
            width: 16,
            height: 16,
            name: "壶",
            properties: [
              { name: "object_type", value: 9 },
              { name: "script_id", value: 100 },
            ],
          },
          {
            gid: 2,
            x: 4 * 16,
            y: (6 + 1) * 16,
            width: 16,
            height: 16,
            name: "看不见的宝箱",
            properties: [
              { name: "object_type", value: 7 },
              { name: "content_id", value: 4 },
              { name: "flag_id", value: 1 },
            ],
          },
          {
            gid: 3,
            x: 7 * 16,
            y: (8 + 1) * 16,
            width: 16,
            height: 16,
            name: "只说话",
            properties: [
              { name: "object_type", value: 9 },
              { name: "script_id", value: 101 },
            ],
          },
        ],
      },
    ],
  };
}

const SCRIPTS = [
  {
    file: "sc_e_0123.json",
    value: {
      Mnemonics: [
        { mnemonic: "ShowMessage", operands: { iValues: [3] } },
        { mnemonic: "GetItem", operands: { iValues: [7, 1] } },
      ],
    },
  },
  {
    file: "sc_e_0124.json",
    value: {
      Mnemonics: [{ mnemonic: "ShowMessage", operands: { iValues: [3] } }],
    },
  },
];
const SCRIPT_NAMES = new Map([
  [100, "sc_e_0123"],
  [101, "sc_e_0124"],
]);
const TREASURE_TYPES = new Map([[1, 2]]);

void test("a pot's GetItem script is a hidden item; a script without a grant is not", () => {
  const items = parseScriptHiddenItems(entity(), SCRIPTS, SCRIPT_NAMES);
  assert.deepEqual(items, [
    {
      cell: [10, 5],
      contentId: 7,
      contentNum: 1,
      flagId: null,
      script: "sc_e_0123",
    },
  ]);
});

void test("hidden treasure objects and script items are merged by cell and item", () => {
  const items = parseHiddenItems(entity(), SCRIPTS, SCRIPT_NAMES, TREASURE_TYPES);
  assert.deepEqual(items, [
    { cell: [4, 6], contentId: 4, contentNum: null, flagId: 1, script: null },
    {
      cell: [10, 5],
      contentId: 7,
      contentNum: 1,
      flagId: null,
      script: "sc_e_0123",
    },
  ]);
});

void test("parseSubmap puts hidden items on the map", () => {
  const parsed = parseSubmap({
    map: MAP,
    entity: entity(),
    treasureTypes: TREASURE_TYPES,
    collision: null,
    damage: null,
    hiddenPassage: null,
    events: [],
    jumpScripts: SCRIPTS,
    scriptNames: SCRIPT_NAMES,
  });
  assert.equal(parsed.hiddenItems.length, 2);
  assert.equal(
    parseSubmap({
      map: MAP,
      entity: entity(),
      treasureTypes: TREASURE_TYPES,
      collision: null,
      damage: null,
      hiddenPassage: null,
      events: [],
    }).hiddenItems.length,
    1,
  );
});

function scriptObject(gid: number, scriptId: number, x: number, y: number): unknown {
  return {
    gid,
    x: x * 16,
    y: (y + 1) * 16,
    width: 16,
    height: 16,
    name: `脚本 ${scriptId}`,
    properties: [
      { name: "object_type", value: 9 },
      { name: "script_id", value: scriptId },
    ],
  };
}

function eventFile(scriptId: number, name: string, x: number, y: number): unknown {
  return {
    layers: [
      {
        objects: [
          {
            gid: 1,
            x: x * 16,
            y: (y + 1) * 16,
            width: 16,
            height: 16,
            name,
            properties: [
              { name: "object_type", value: 2 },
              { name: "script_id", value: scriptId },
            ],
          },
        ],
      },
    ],
  };
}

void test("off-map script duplicates collapse to the in-map cell or the event trigger", () => {
  const scripts = [
    {
      file: "sc_a.json",
      value: {
        Mnemonics: [{ mnemonic: "GetItem", operands: { iValues: [9, 1] } }],
      },
    },
    {
      file: "sc_b.json",
      value: {
        Mnemonics: [{ mnemonic: "GetItem", operands: { iValues: [10, 1] } }],
      },
    },
    {
      file: "sc_c.json",
      value: {
        Mnemonics: [{ mnemonic: "GetItem", operands: { iValues: [11, 1] } }],
      },
    },
  ];
  const scriptNames = new Map([
    [200, "sc_a"],
    [201, "sc_b"],
    [202, "sc_c"],
  ]);
  const parsed = parseSubmap({
    map: MAP,
    entity: {
      layers: [
        {
          objects: [
            scriptObject(1, 200, -1, 4),
            scriptObject(2, 200, 5, 6),
            scriptObject(3, 200, 6, 7),
            scriptObject(4, 201, -1, 4),
            scriptObject(5, 202, -1, 4),
          ],
        },
      ],
    },
    collision: {
      layers: [
        {
          name: "GroundCollision",
          type: "tilelayer",
          width: 20,
          height: 20,
          data: new Array(400).fill(0),
        },
      ],
    },
    damage: null,
    hiddenPassage: null,
    events: [{ file: "ev_e_1.json", value: eventFile(201, "sc_b", 12, 12) }],
    jumpScripts: scripts,
    scriptNames,
  });
  assert.deepEqual(
    parsed.hiddenItems.map((item) => [item.script, item.contentId, item.cell]),
    [
      ["sc_a", 9, [5, 6]],
      ["sc_b", 10, [12, 12]],
    ],
  );
  assert.equal(parsed.hiddenItemSkipped, 1);
  assert.equal(parsed.width, 20);
  assert.equal(parsed.height, 20);
});

function placedObject(name: string, x: number, y: number, entityId: number, scriptId = 0): unknown {
  return {
    gid: 1001,
    x: x * 16,
    y: (y + 1) * 16,
    width: 16,
    height: 16,
    name,
    properties: [
      { name: "object_type", value: 5 },
      { name: "entity_id", value: entityId },
      { name: "script_id", value: scriptId },
    ],
  };
}

void test("an event cell comes from its entity_default object, not a same-name duplicate", () => {
  const entity = {
    layers: [
      {
        objects: [
          placedObject("sc_e_0206:扉が開く", 22, 6, 11, 2003),
          placedObject("sc_same", 5, 5, 1),
          placedObject("sc_same", 9, 9, 2),
        ],
      },
    ],
  };
  const event = {
    layers: [
      {
        objects: [placedObject("sc_e_0206:扉が開く", 19, 6, 11), placedObject("sc_same", 1, 1, 2)],
      },
    ],
  };
  const parsed = parseSubmap({
    map: { ...MAP, id: 193, name: "Map_30021_2", packageName: "Map_30021" },
    entity,
    collision: null,
    damage: null,
    hiddenPassage: null,
    events: [{ file: "ev_e_0207.json", value: event }],
  });
  assert.deepEqual(
    parsed.events.map((entry) => [entry.name, entry.cell]),
    [
      ["sc_e_0206:扉が開く", [22, 6]],
      ["sc_same", [9, 9]],
    ],
  );
});

void test("an object_type 10 boss carries its EncountBoss group and party monsters", () => {
  const event = {
    layers: [
      {
        objects: [
          {
            gid: 1,
            x: 14 * 16,
            y: (11 + 1) * 16,
            width: 16,
            height: 16,
            name: "ウィングラプター",
            properties: [
              { name: "object_type", value: 10 },
              { name: "script_id", value: 41 },
              { name: "entity_id", value: 17 },
            ],
          },
        ],
      },
    ],
  };
  const script = {
    file: "sc_e_0016.json",
    value: {
      Mnemonics: [{ mnemonic: "EncountBoss", operands: { iValues: [440, 14, 15] } }],
    },
  };
  const parsed = parseSubmap({
    map: { ...MAP, id: 205, name: "Map_30041_4", packageName: "Map_30041" },
    entity: { layers: [] },
    collision: null,
    damage: null,
    hiddenPassage: null,
    events: [{ file: "ev_e_0016.json", value: event }],
    jumpScripts: [script],
    scriptNames: new Map([[41, "sc_e_0016"]]),
    monsterParties: new Map([[440, [14, 15]]]),
  });
  assert.deepEqual(
    parsed.events.map((entry) => [
      entry.name,
      entry.objectType,
      entry.cell,
      entry.encounterGroupId,
      entry.monsterIds,
    ]),
    [["ウィングラプター", 10, [14, 11], 440, [14, 15]]],
  );
});

void test("monster.csv rewards keep exp, gil and ABP by monster id", () => {
  const rewards = parseMonsterRewards(
    [
      "id,mes_id_name,boss,exp,gil,abp",
      "5,MSG_MON_NAME_901,0,12,7,3",
      "6,MSG_MON_NAME_902,0,,,",
      "7,MSG_MON_NAME_903,1,0,0,0",
    ].join("\n"),
  );
  assert.deepEqual(rewards.get(5), { exp: 12, gil: 7, abp: 3 });
  assert.deepEqual(rewards.get(6), { exp: null, gil: null, abp: null });
  assert.deepEqual(rewards.get(7), { exp: 0, gil: 0, abp: 0 });
  const aliases = parseMonsterRewards("id,experience,gold,ability_point\n8,20,9,2");
  assert.deepEqual(aliases.get(8), { exp: 20, gil: 9, abp: 2 });
});

void test("a map file carries hidden items and clerk NPCs", () => {
  const parsed = parseGameMapFile({
    id: 30,
    name: "Map_92010",
    areaId: 9,
    saveAvailable: true,
    width: 20,
    height: 20,
    chests: [],
    hiddenItems: [
      {
        cell: [4, 5],
        contentId: 1,
        contentNum: 1,
        flagId: null,
        script: "sc_e_0123",
      },
    ],
    npcs: [{ cell: [3, 3], name: "店员", shopId: 3 }],
    hiddenItemSkipped: 2,
    savePoints: [],
    restorePoints: [],
  });
  assert.ok(parsed !== null);
  assert.deepEqual(parsed.hiddenItems, [
    {
      cell: [4, 5],
      contentId: 1,
      contentNum: 1,
      flagId: null,
      script: "sc_e_0123",
    },
  ]);
  assert.deepEqual(parsed.npcs, [{ cell: [3, 3], name: "店员", shopId: 3 }]);
  assert.equal(parsed.width, 20);
  assert.equal(parsed.height, 20);
  assert.equal(parsed.hiddenItemSkipped, 2);
});
