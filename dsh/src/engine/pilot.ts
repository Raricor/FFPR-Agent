/**
 * The one way the engine reaches the game: the seam between the laptop link (LAN bridge first,
 * pilot agent over SSH otherwise; ported from ffpr_agent/pilot.py) and everything above it.
 * Skills, the view and the Game take a Pilot, never a laptop or a socket, so tests drive them
 * with a scripted fake and fake time.
 *
 * A Pilot is bound to one tool call: its calls, sleeps and waits all end when that call is
 * cancelled, so skills need not pass a signal through every function.
 */

export type Fields = Record<string, unknown>;

/** A pilot or bridge result. Shapes vary by op, so callers narrow what they read. */
export type Reply = Record<string, unknown>;

export interface Pilot {
  /**
   * One pilot op (Python pilot.send): answered over the LAN link when it can be (pos, cells,
   * entities, collision, route, bridge, keys, status), else by the pilot agent. The result has
   * the same shape either way. `waitMs` is how long the agent may take (Python `_wait`, 30 s).
   */
  send(op: string, fields?: Fields, waitMs?: number): Promise<Reply>;
  /** One bridge query (Python pilot.query): the bridge's reply, {} when there is none. */
  query(q: string, fields?: Fields): Promise<Reply>;
  /** Run a PowerShell script on the laptop over SSH (Python laptop.run_ps with capture). */
  runPs(script: string): Promise<string>;
  /** Python's time.sleep in polling loops; rejects when the tool call is cancelled. */
  sleep(ms: number): Promise<void>;
  /** Python's time.monotonic, in milliseconds, for deadlines in polling loops. */
  now(): number;
}
