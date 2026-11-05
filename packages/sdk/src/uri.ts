// The URIs of durabase. explain/uris.md in the docs repo has the grammar:
//
//   db://shop/orders/LP-1004#state
//   mail://help@littleplay.co/messages
//   auth://main/users/4b1e…
//   files://media/products/brick-kit/1.jpg
//
// Each URI has one route: the scheme, then the authority, then the path.
// db://shop is POST /db/shop.

export type Scheme = "db" | "mail" | "auth" | "files";
const SCHEMES: readonly string[] = ["db", "mail", "auth", "files"];

const LABEL = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const ADDRESS = /^[a-z0-9._+-]+@[a-z0-9][a-z0-9.-]*$/;

export interface Address {
  scheme: Scheme;
  // The DO name: a namespace, an email address, a realm, or a bucket.
  authority: string;
  // The parts after the authority, decoded.
  path: string[];
}

function validAuthority(scheme: Scheme, authority: string): boolean {
  return scheme === "mail" ? ADDRESS.test(authority) : LABEL.test(authority);
}

// "db://shop" → { scheme: "db", authority: "shop", path: [] }
export function parseUri(uri: string): Address {
  const m = /^([a-z]+):\/\/([^/#?]+)(\/[^#?]*)?$/.exec(uri);
  if (!m || !SCHEMES.includes(m[1])) throw new TypeError(`not a durabase URI: ${uri}`);
  const scheme = m[1] as Scheme;
  const authority = decodeURIComponent(m[2]).toLowerCase();
  if (!validAuthority(scheme, authority)) throw new TypeError(`not a valid ${scheme} name: ${authority}`);
  const path = (m[3] ?? "").split("/").filter(Boolean).map(decodeURIComponent);
  return { scheme, authority, path };
}

// "/db/shop" → { scheme: "db", authority: "shop", path: [] }
export function parseRoute(pathname: string): Address | undefined {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2 || !SCHEMES.includes(parts[0])) return undefined;
  const scheme = parts[0] as Scheme;
  let authority: string;
  try {
    authority = decodeURIComponent(parts[1]).toLowerCase();
  } catch {
    return undefined;
  }
  if (!validAuthority(scheme, authority)) return undefined;
  try {
    return { scheme, authority, path: parts.slice(2).map(decodeURIComponent) };
  } catch {
    return undefined;
  }
}

// The route of a URI: db://shop → /db/shop.
export function routeOf(address: Address): string {
  return ["", address.scheme, encodeURIComponent(address.authority), ...address.path.map(encodeURIComponent)].join("/").replaceAll("%40", "@");
}

// The default binding of each scheme.
export const BINDINGS: Record<Scheme, string> = {
  db: "DB",
  mail: "MAILBOX",
  auth: "AUTH",
  files: "FILES",
};
