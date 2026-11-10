// In-memory stand-in for the Electron file layer, used only when the UI is
// opened in a normal browser (npm run preview). Nothing is saved.
import type { Api, FileState } from "../shared/api";
import { Data, OpError, apply, today } from "../shared/model";
import { sampleData } from "../shared/sample";

export function createMockApi(): Api {
  let data: Data = sampleData();
  let listener: (s: FileState) => void = () => {};
  const state = (): FileState => ({ status: "ready", file: "D:\\Dashboard\\projects.json (preview, not saved)", data });
  (window as unknown as { mockData: () => Data }).mockData = () => data;
  return {
    getState: async () => state(),
    apply: async (op) => {
      try {
        data = apply(data, op, today());
        listener(state());
        return { ok: true };
      } catch (e) {
        return { ok: false, message: e instanceof OpError ? e.message : String(e) };
      }
    },
    createFile: async () => ({ ok: false, message: "Not available in the browser preview." }),
    openFile: async () => ({ ok: false, message: "Not available in the browser preview." }),
    retry: async () => {},
    revealFile: async () => {},
    onState: (cb) => { listener = cb; },
    ready: () => {},
  };
}
