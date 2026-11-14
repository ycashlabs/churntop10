import { useEffect, useState } from "react";
import type { SimulatorView, Summary } from "../lib/api-types";
import { getSimulator, getSummaryRead } from "./api";
import { Sparkline } from "./chrome";
import {
  defaultStripBook,
  etDateFromClock,
  rememberSample,
  startStripPoll,
  stripModelFromSimulator,
  stripModelFromSummary,
  stripPollPath,
  type Book,
} from "./strip";

function pnlTile(id: string): boolean {
  return id === "day" || id === "total" || id === "best" || id === "worst";
}

export function AccountStrip({ summary }: { summary: Summary }) {
  const [book, setBook] = useState<Book>(() => defaultStripBook(summary.mode));
  const [sim, setSim] = useState<SimulatorView | null>(null);
  const [live, setLive] = useState<Summary>(summary);

  useEffect(() => { setBook(defaultStripBook(summary.mode)); }, [summary.mode]);
  useEffect(() => { setLive(summary); }, [summary]);

  useEffect(() => {
    let cancelled = false;
    getSimulator().then((next) => { if (!cancelled) setSim(next); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    return startStripPoll({
      book: () => book,
      load: (path) => {
        if (path === stripPollPath("sim")) {
          getSimulator().then(setSim).catch(() => undefined);
          return;
        }
        getSummaryRead().then(setLive).catch(() => undefined);
      },
    });
  }, [book]);

  const etDate = etDateFromClock((book === "sim" ? sim?.clock : live.clock) ?? summary.clock);
  const model = book === "sim" ? (sim ? stripModelFromSimulator(sim) : null) : stripModelFromSummary(live);

  return (
    <div className="strip-wrap" aria-label="Account strip">
      <div className="strip-badge">
        <div className="tile-label">Book</div>
        <div className="strip-toggle" role="group" aria-label="Sim or Live account figures">
          <button type="button" className={book === "sim" ? "on" : ""} aria-pressed={book === "sim"} onClick={() => setBook("sim")}>Sim</button>
          <button type="button" className={book === "live" ? "on" : ""} aria-pressed={book === "live"} onClick={() => setBook("live")}>Live</button>
        </div>
        <div className="book-meta">{book === "live" ? (model?.maskedAccount ?? "Live book") : "Sim book"}</div>
      </div>
      {model ? (
        <div className="strip-tiles">
          {model.tiles.map((tile) => {
            const samples = rememberSample(`${book}:${tile.id}`, tile.sample, etDate);
            return (
              <div className="tile" key={tile.id} title={tile.title}>
                <div className="tile-label">{tile.label}</div>
                <div className={pnlTile(tile.id) && tile.direction !== "muted" ? `tile-value ${tile.direction}` : "tile-value"}>{tile.value}</div>
                <div className={tile.change === "paused" ? "tile-change warning" : `tile-change ${tile.direction}`}>{tile.change}</div>
                <Sparkline samples={samples} />
              </div>
            );
          })}
        </div>
      ) : <p className="strip-loading">Loading the simulator…</p>}
    </div>
  );
}
