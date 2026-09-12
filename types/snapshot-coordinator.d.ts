declare module "*.cjs" {
  export interface SnapshotCoordinator {
    run(snapshotTask: () => void | Promise<void>): Promise<void>;
  }

  export function createSnapshotCoordinator(): SnapshotCoordinator;
}
