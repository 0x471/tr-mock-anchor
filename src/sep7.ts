/** SEP-7 `web+stellar:pay` URI so a wallet can open a pre-filled payment (one click / QR scan). */
export function stellarPayUri(args: {
  destination: string;
  assetCode: string;
  assetIssuer: string;
  memoId?: string | null;
  amount?: string | null;
  msg?: string;
}): string {
  const q = new URLSearchParams();
  q.set('destination', args.destination);
  if (args.amount) q.set('amount', args.amount);
  q.set('asset_code', args.assetCode);
  q.set('asset_issuer', args.assetIssuer);
  if (args.memoId) {
    q.set('memo', args.memoId);
    q.set('memo_type', 'MEMO_ID');
  }
  if (args.msg) q.set('msg', args.msg.slice(0, 300));
  return `web+stellar:pay?${q.toString()}`;
}
