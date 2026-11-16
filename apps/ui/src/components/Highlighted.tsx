import { Fragment } from "react";
import { splitHighlights } from "../memory-model";
import "../history.css";

export function Highlighted({ text, ranges }: { text: string; ranges: readonly (readonly [number, number])[] }) {
  return (
    <>
      {splitHighlights(text, ranges).map((segment, index) =>
        segment.hit ? (
          <mark key={index} className="hl">
            {segment.text}
          </mark>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}
