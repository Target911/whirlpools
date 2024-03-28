import { TransferFee, calculateFee, getEpochFee, getTransferFeeConfig, TOKEN_2022_PROGRAM_ID, getTransferHook, addExtraAccountMetasForExecute } from "@solana/spl-token";
import BN from "bn.js";
import { MintWithTokenProgram, U64_MAX, ZERO } from "@orca-so/common-sdk";
import { IGNORE_CACHE, PoolUtil, WhirlpoolAccountFetchOptions, WhirlpoolAccountFetcherInterface, WhirlpoolData } from "..";
import { AccountMeta, Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/utils/token";

export type TokenAmountWithFee = {
  isFeeIncludedAmount: boolean;
  amount: BN;
  fee: BN;
};

export type TokenExtensionContext = {
  currentEpoch: number;
  tokenMintWithProgramA: MintWithTokenProgram;
  tokenMintWithProgramB: MintWithTokenProgram;
  rewardTokenMintsWithProgram: [
    MintWithTokenProgram | null,
    MintWithTokenProgram | null,
    MintWithTokenProgram | null,
  ];
};

export type TokenExtensionContextForPool = Omit<TokenExtensionContext, "rewardTokenMintsWithProgram">;
export type TokenExtensionContextForReward = Omit<TokenExtensionContext, "tokenMintWithProgramA" | "tokenMintWithProgramB">;

const defaultTokenMintWithProgram: MintWithTokenProgram = {
  address: PublicKey.default,
  decimals: 0,
  freezeAuthority: null,
  mintAuthority: null,
  isInitialized: true,
  supply: 0n,
  tlvData: Buffer.from([]),
  tokenProgram: TOKEN_PROGRAM_ID,
};

export const NO_TOKEN_EXTENSION_CONTEXT: TokenExtensionContext = {
  currentEpoch: 0,
  tokenMintWithProgramA: defaultTokenMintWithProgram,
  tokenMintWithProgramB: defaultTokenMintWithProgram,
  rewardTokenMintsWithProgram: [
    defaultTokenMintWithProgram,
    defaultTokenMintWithProgram,
    defaultTokenMintWithProgram,
  ],
};

export class TokenExtensionUtil {
  public static calculateTransferFeeIncludedAmount(
    transferFeeExcludedAmount: BN,
    tokenInfo: MintWithTokenProgram,
    currentEpoch: number,
  ): TokenAmountWithFee {
    const config = getTransferFeeConfig(tokenInfo);
    if (config === null) {
      return { isFeeIncludedAmount: true, amount: transferFeeExcludedAmount, fee: ZERO };
    }

    const transferFee = getEpochFee(config, BigInt(currentEpoch));
    return calculateTransferFeeIncludedAmount(transferFee, transferFeeExcludedAmount);
  }

  public static calculateTransferFeeExcludedAmount(
    transferFeeIncludedAmount: BN,
    tokenInfo: MintWithTokenProgram,
    currentEpoch: number,
  ): TokenAmountWithFee {
    const config = getTransferFeeConfig(tokenInfo);
    if (config === null) {
      return { isFeeIncludedAmount: false, amount: transferFeeIncludedAmount, fee: ZERO };
    }

    const transferFee = getEpochFee(config, BigInt(currentEpoch));
    return calculateTransferFeeExcludedAmount(transferFee, transferFeeIncludedAmount);
  }

  public static async buildTokenExtensionContext(
    fetcher: WhirlpoolAccountFetcherInterface,
    whirlpoolData: WhirlpoolData,
    opts?: WhirlpoolAccountFetchOptions,
  ): Promise<TokenExtensionContext> {
    const mintA = whirlpoolData.tokenMintA;
    const mintB = whirlpoolData.tokenMintB;
    const rewards = whirlpoolData.rewardInfos;

    const [tokenMintWithProgram, currentEpoch] = await Promise.all([
      fetcher.getMintInfos([
        mintA,
        mintB,
        ...rewards.filter((r) => PoolUtil.isRewardInitialized(r)).map((r) => r.mint),
      ], opts),
      fetcher.getEpoch()
    ]);

    const get = (mint: PublicKey) => tokenMintWithProgram.get(mint.toBase58())!;

    return {
      tokenMintWithProgramA: get(whirlpoolData.tokenMintA),
      tokenMintWithProgramB: get(whirlpoolData.tokenMintB),
      rewardTokenMintsWithProgram: [
        PoolUtil.isRewardInitialized(rewards[0]) ? get(rewards[0].mint) : null,
        PoolUtil.isRewardInitialized(rewards[1]) ? get(rewards[1].mint) : null,
        PoolUtil.isRewardInitialized(rewards[2]) ? get(rewards[2].mint) : null,
      ],
      currentEpoch,
    };
  }

  public static async getExtraAccountMetasForTransferHook(
    connection: Connection,
    tokenMintWithProgram: MintWithTokenProgram,
    source: PublicKey,
    destination: PublicKey,
    owner: PublicKey,
  ): Promise<AccountMeta[] | undefined> {
    const transferHook = getTransferHook(tokenMintWithProgram);

    if (!transferHook) return undefined;

    const instruction = new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      keys: [
        {pubkey: source, isSigner: false, isWritable: false},
        {pubkey: tokenMintWithProgram.address, isSigner: false, isWritable: false},
        {pubkey: destination, isSigner: false, isWritable: false},
        {pubkey: owner, isSigner: false, isWritable: false},
        {pubkey: owner, isSigner: false, isWritable: false},
      ]
    });
  
    await addExtraAccountMetasForExecute(
      connection,
      instruction,
      transferHook.programId,
      source,
      tokenMintWithProgram.address,
      destination,
      owner,
      0n, // extra account must not depend on the amount (the acount will be changed due to slippage)
      "confirmed"
    );
  
    const extraAccountMetas = instruction.keys.slice(5);
    return extraAccountMetas.length > 0
      ? extraAccountMetas
      : undefined;
  }
  
  public static isV2IxRequiredPool(
    tokenExtensionCtx: TokenExtensionContextForPool
  ): boolean {
    if (tokenExtensionCtx.tokenMintWithProgramA.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) return true;
    if (tokenExtensionCtx.tokenMintWithProgramB.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) return true;
    return false;
  }

  public static isV2IxRequiredReward(
    tokenExtensionCtx: TokenExtensionContextForReward,
    rewardIndex: number,
  ): boolean {
    return tokenExtensionCtx.rewardTokenMintsWithProgram[rewardIndex]?.tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ?? false;
  }
}

function ceilDivBN(num: BN, denom: BN): BN {
  return num.add(denom.subn(1)).div(denom);
}

function calculateTransferFeeIncludedAmount(
  transferFee: TransferFee,
  amount: BN,
): TokenAmountWithFee {
  // https://github.com/solana-labs/solana-program-library/blob/master/token/program-2022/src/extension/transfer_fee/mod.rs#L90

  const ONE_IN_BASIS_POINTS = 10_000;
  const maxFeeBN = new BN(transferFee.maximumFee.toString());

  // edge cases

  if (transferFee.transferFeeBasisPoints === 0) {
    return {
      isFeeIncludedAmount: true,
      amount,
      fee: ZERO,
    };
  }
  
  if (amount.isZero()) {
    return {
      isFeeIncludedAmount: true,
      amount,
      fee: ZERO,
    };
  }

  if (transferFee.transferFeeBasisPoints === ONE_IN_BASIS_POINTS) {
    if (amount.add(maxFeeBN).gt(U64_MAX)) {
      throw new Error("The total amount and fees overflow");
    }
    return {
      isFeeIncludedAmount: true,
      amount: amount.add(maxFeeBN),
      fee: maxFeeBN,
    };
  }

  // normal case

  const num = amount.muln(ONE_IN_BASIS_POINTS);
  const denom = new BN(ONE_IN_BASIS_POINTS - transferFee.transferFeeBasisPoints);
  const rawFeeIncludedAmount = ceilDivBN(num, denom);

  const result = rawFeeIncludedAmount.sub(amount).gte(maxFeeBN)
    ? { amount: amount.add(maxFeeBN), fee: maxFeeBN }
    : { amount: rawFeeIncludedAmount, fee: rawFeeIncludedAmount.sub(amount) };

  if (result.amount.gt(U64_MAX)) {
    throw new Error("The total amount and fees overflow");
  }

  return { ...result, isFeeIncludedAmount: true };
}

function calculateTransferFeeExcludedAmount(
  transferFee: TransferFee,
  amount: BN,
): TokenAmountWithFee {
  const fee = calculateFee(transferFee, BigInt(amount.toString()));
  const feeBN = new BN(fee.toString());
  return {
    isFeeIncludedAmount: false,
    amount: amount.sub(feeBN),
    fee: feeBN,
  };
}
