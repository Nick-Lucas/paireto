export interface FixtureRoute {
  path: RegExp;
  targets?: RegExp[];
}

export function isFixtureRequest(
  routes: readonly FixtureRoute[],
  path: string,
  target: string | undefined,
): boolean {
  return routes.some(
    (route) =>
      route.path.test(path) &&
      (route.targets === undefined ||
        (target !== undefined && route.targets.some((matcher) => matcher.test(target)))),
  );
}
