export interface LatestGate {
  show: (id: string) => void;
  begin: (id: string) => () => boolean;
  close: () => void;
}

export function createLatestGate(): LatestGate {
  let seq = 0;
  let shown: string | null = null;
  return {
    show: (id) => {
      if (shown === id) return;
      shown = id;
      seq += 1;
    },
    begin: (id) => {
      shown = id;
      seq += 1;
      const mine = seq;
      return () => mine === seq && shown === id;
    },
    close: () => {
      shown = null;
      seq += 1;
    },
  };
}
