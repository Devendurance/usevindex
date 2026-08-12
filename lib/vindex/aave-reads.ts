import "server-only";
import { AAVE_V3_BASE_SEPOLIA, ERC20_ABI } from "./aave-registry";
import type { CanonicalReadClient } from "./public-client";

export async function readAaveUsdcAllowance(
  client: CanonicalReadClient,
  owner: `0x${string}`,
  spender: `0x${string}`,
): Promise<bigint> {
  const result = await client.readContract({
    address: AAVE_V3_BASE_SEPOLIA.usdcUnderlying,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender],
  });
  return BigInt(result);
}

export async function readNativeBalance(
  client: CanonicalReadClient,
  address: `0x${string}`,
): Promise<bigint> {
  const result = await client.getBalance({ address });
  return result as bigint;
}
