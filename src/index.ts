// @fairchild/table-core: server-backed table rows, framework-free. Everything public is exported here; nothing else in
// this package is part of its contract.
export type { SortDirection, SortItem, TableView, TableFilter, FilterValue, Selection, Total, TableState } from './types.ts';
export { isSelected, setSelected, removeFromSelection, selectionCount } from './selection.ts';
export {
  ServerRowsStore, pageKey,
  type ServerRowsConfig, type ServerRowsRequest, type ServerRowsResponse, type ServerCountRequest, type ServerRowsSnapshot,
} from './server-rows-store.ts';
