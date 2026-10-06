export function createBrowserTestPlugin(): Promise<{
  name: string;
  enforce: "pre";
  transform(code: string, id: string): { code: string; map: null } | undefined;
}>;
