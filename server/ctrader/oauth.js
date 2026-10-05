/**
 * cTrader ID OAuth helpers. The "accounts" scope is read-only: the dashboard
 * can see balances and trades but can never place or change orders.
 */
export function authorizeUrl({ authBase, clientId, redirectUri }) {
  const url = new URL('/my/settings/openapi/grantingaccess/', authBase);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'accounts');
  url.searchParams.set('product', 'web');
  return url.toString();
}

async function tokenRequest(tokenUrl, params) {
  const url = new URL(tokenUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Error('Could not reach cTrader to log in.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errorCode || !data.accessToken) {
    throw new Error(data.description || data.errorCode || `cTrader login failed (${res.status}).`);
  }
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + (Number(data.expiresIn) || 30 * 24 * 3600) * 1000,
  };
}

export function exchangeCode({ tokenUrl, clientId, clientSecret, redirectUri, code }) {
  return tokenRequest(tokenUrl, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
}

export function refreshTokens({ tokenUrl, clientId, clientSecret, refreshToken }) {
  return tokenRequest(tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
}
