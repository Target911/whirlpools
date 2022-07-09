import { Address } from "@project-serum/anchor";
import { u64 } from "@solana/spl-token";
import invariant from "tiny-invariant";
import { PoolUtil } from "../../utils/public/pool-utils";
import { SwapInput } from "../../instructions";
import { WhirlpoolData, TickArray } from "../../types/public";
import { AddressUtil, Percentage } from "@orca-so/common-sdk";
import { TickArrayUtil, TokenType } from "../../utils/public";
import { Whirlpool } from "../../whirlpool-client";
import { AccountFetcher } from "../../network/public";
import { simulateSwap } from "../swap/swap-quote-impl";
import { SwapUtils } from "../../utils/public/swap-utils";

/**
 * @category Quotes
 *
 * @param tokenAmount - The amount of input or output token to swap from (depending on amountSpecifiedIsInput).
 * @param otherAmountThreshold - The maximum/minimum of input/output token to swap into (depending on amountSpecifiedIsInput).
 * @param sqrtPriceLimit - The maximum/minimum price the swap will swap to.
 * @param aToB - The direction of the swap. True if swapping from A to B. False if swapping from B to A.
 * @param amountSpecifiedIsInput - Specifies the token the parameter `amount`represents. If true, the amount represents
 *                                 the input token of the swap.
 * @param slippageTolerance - The amount of slippage to account for in this quote
 * @param tickArrays - An sequential array of tick-array objects in the direction of the trade to swap on
 */
export type SwapQuoteParam = {
  whirlpoolData: WhirlpoolData;
  tokenAmount: u64;
  otherAmountThreshold: u64;
  sqrtPriceLimit: u64;
  aToB: boolean;
  amountSpecifiedIsInput: boolean;
  slippageTolerance: Percentage;
  tickArrays: TickArray[];
};

/**
 * A collection of estimated values from quoting a swap.
 * @category Quotes
 * @param estimatedAmountIn - Approximate number of input token swapped in the swap
 * @param estimatedAmountOut - Approximate number of output token swapped in the swap
 * @param estimatedEndTickIndex - Approximate tick-index the Whirlpool will land on after this swap
 * @param estimatedEndSqrtPrice - Approximate sqrtPrice the Whirlpool will land on after this swap
 * @param estimatedFeeAmount - Approximate feeAmount (all fees) charged on this swap
 */
export type SwapQuote = {
  estimatedAmountIn: u64;
  estimatedAmountOut: u64;
  estimatedEndTickIndex: number;
  estimatedEndSqrtPrice: u64;
  estimatedFeeAmount: u64;
} & SwapInput;

/**
 * Get an estimated swap quote using input token amount.
 *
 * @category Quotes
 * @param whirlpool - Whirlpool to perform the swap on
 * @param inputTokenMint - PublicKey for the input token mint to swap with
 * @param tokenAmount - The amount of input token to swap from
 * @param slippageTolerance - The amount of slippage to account for in this quote
 * @param programId - PublicKey for the Whirlpool ProgramId
 * @param fetcher - AccountFetcher object to fetch solana accounts
 * @param refresh - If true, fetcher would default to fetching the latest accounts
 * @returns a SwapQuote object with estimates on token amounts, fee & end whirlpool states.
 */
export async function swapQuoteByInputToken(
  whirlpool: Whirlpool,
  inputTokenMint: Address,
  tokenAmount: u64,
  slippageTolerance: Percentage,
  programId: Address,
  fetcher: AccountFetcher,
  refresh: boolean
): Promise<SwapQuote> {
  const whirlpoolData = whirlpool.getData();
  const swapMintKey = AddressUtil.toPubKey(inputTokenMint);
  const swapTokenType = PoolUtil.getTokenType(whirlpoolData, swapMintKey);
  invariant(!!swapTokenType, "swapTokenMint does not match any tokens on this pool");

  const aToB = swapTokenType === TokenType.TokenA;
  const amountSpecifiedIsInput = true;

  const tickArrays = await SwapUtils.getTickArrays(
    whirlpoolData.tickCurrentIndex,
    whirlpoolData.tickSpacing,
    aToB,
    AddressUtil.toPubKey(programId),
    whirlpool.getAddress(),
    fetcher,
    refresh
  );

  checkIfAllTickArraysInitialized(tickArrays);

  return simulateSwap({
    whirlpoolData,
    tokenAmount,
    aToB,
    amountSpecifiedIsInput,
    sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToB),
    otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(amountSpecifiedIsInput),
    slippageTolerance,
    tickArrays,
  });
}

/**
 * Get an estimated swap quote using an output token amount.
 *
 * Use this quote to get an estimated amount of input token needed to receive
 * the defined output token amount.
 *
 * @category Quotes
 * @param whirlpool - Whirlpool to perform the swap on
 * @param outputTokenMint - PublicKey for the output token mint to swap into
 * @param tokenAmount - The maximum amount of output token to receive in this swap.
 * @param slippageTolerance - The amount of slippage to account for in this quote
 * @param programId - PublicKey for the Whirlpool ProgramId
 * @param fetcher - AccountFetcher object to fetch solana accounts
 * @param refresh - If true, fetcher would default to fetching the latest accounts
 * @returns a SwapQuote object with estimates on token amounts, fee & end whirlpool states.
 */
export async function swapQuoteByOutputToken(
  whirlpool: Whirlpool,
  outputTokenMint: Address,
  tokenAmount: u64,
  slippageTolerance: Percentage,
  programId: Address,
  fetcher: AccountFetcher,
  refresh: boolean
): Promise<SwapQuote> {
  const whirlpoolData = whirlpool.getData();
  const swapMintKey = AddressUtil.toPubKey(outputTokenMint);
  const swapTokenType = PoolUtil.getTokenType(whirlpoolData, swapMintKey);
  invariant(!!swapTokenType, "swapTokenMint does not match any tokens on this pool");

  const aToB = swapTokenType === TokenType.TokenB;
  const amountSpecifiedIsInput = false;

  const tickArrays = await SwapUtils.getTickArrays(
    whirlpoolData.tickCurrentIndex,
    whirlpoolData.tickSpacing,
    aToB,
    AddressUtil.toPubKey(programId),
    whirlpool.getAddress(),
    fetcher,
    refresh
  );

  checkIfAllTickArraysInitialized(tickArrays);

  return simulateSwap({
    whirlpoolData,
    tokenAmount,
    aToB,
    amountSpecifiedIsInput,
    sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToB),
    otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(amountSpecifiedIsInput),
    slippageTolerance,
    tickArrays,
  });
}

/**
 * Perform a sync swap quote based on the basic swap instruction parameters.
 * @param params - SwapQuote parameters
 * @returns a SwapQuote object with estimates on token amounts, fee & end whirlpool states.
 */
export function swapQuoteWithParams(params: SwapQuoteParam) {
  return simulateSwap(params);
}

function checkIfAllTickArraysInitialized(tickArrays: TickArray[]) {
  // Check if all the tick arrays have been initialized.
  const uninitializedIndices = TickArrayUtil.getUninitializedArrays(
    tickArrays.map((array) => array.data)
  );
  if (uninitializedIndices.length > 0) {
    const uninitializedArrays = uninitializedIndices
      .map((index) => tickArrays[index].address.toBase58())
      .join(", ");
    throw new Error(`TickArray addresses - [${uninitializedArrays}] need to be initialized.`);
  }
}
