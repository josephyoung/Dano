const ANONYMOUS_USER_BOOTSTRAP_LOCK = "dano-anonymous-user-bootstrap";

export function createBrowserClient(
  request: () => Promise<Response>,
): Promise<Response> {
  const locks = navigator.locks;
  return locks
    ? locks.request(ANONYMOUS_USER_BOOTSTRAP_LOCK, request)
    : request();
}
