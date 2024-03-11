import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { MathUtil, PDA, Percentage, ZERO } from "@orca-so/common-sdk";
import * as assert from "assert";
import Decimal from "decimal.js";
import {
  buildWhirlpoolClient,
  collectRewardsQuote,
  DecreaseLiquidityQuote,
  decreaseLiquidityQuoteByLiquidityWithParams,
  DecreaseLiquidityV2Params,
  IncreaseLiquidityV2Params,
  InitPoolV2Params,
  NUM_REWARDS,
  PDAUtil,
  PoolUtil,
  PositionData,
  PriceMath,
  SwapQuote,
  swapQuoteWithParams,
  SwapUtils,
  toTokenAmount,
  toTx,
  twoHopSwapQuoteFromSwapQuotes,
  TwoHopSwapV2Params,
  WhirlpoolContext,
  WhirlpoolData,
  WhirlpoolIx,
} from "../../../../src";
import { IGNORE_CACHE } from "../../../../src/network/public/fetcher";
import {
  getTokenBalance,
  sleep,
  TEST_TOKEN_2022_PROGRAM_ID,
  TickSpacing,
  ZERO_BN,
} from "../../../utils";
import { defaultConfirmOptions } from "../../../utils/const";
import { WhirlpoolTestFixtureV2 } from "../../../utils/v2/fixture-v2";
import {
  FundedPositionV2Params,
  TokenTrait,
  fundPositionsV2,
  initTestPoolWithTokensV2,
} from "../../../utils/v2/init-utils-v2";
import {
  calculateTransferFeeExcludedAmount,
  calculateTransferFeeIncludedAmount,
  createTokenAccountV2,
  disableRequiredMemoTransfers,
  enableRequiredMemoTransfers,
  isRequiredMemoTransfersEnabled,
} from "../../../utils/v2/token-2022";
import { PublicKey } from "@solana/web3.js";
import { initTickArrayRange } from "../../../utils/init-utils";
import {
  InitAquariumV2Params,
  TestAquarium,
  buildTestAquariumsV2,
  getDefaultAquariumV2,
  getTokenAccsForPoolsV2,
} from "../../../utils/v2/aquarium-v2";
import {
  TransferFee,
  getEpochFee,
  getMint,
  getTransferFeeConfig,
  transfer,
} from "@solana/spl-token";

describe("TokenExtension/TransferFee", () => {
  const provider = anchor.AnchorProvider.local(undefined, defaultConfirmOptions);
  const program = anchor.workspace.Whirlpool;
  const ctx = WhirlpoolContext.fromWorkspace(provider, program);
  const fetcher = ctx.fetcher;
  const client = buildWhirlpoolClient(ctx);

  async function getTransferFee(mint: PublicKey): Promise<TransferFee> {
    const mintData = await getMint(
      provider.connection,
      mint,
      undefined,
      TEST_TOKEN_2022_PROGRAM_ID,
    );
    const transferFeeConfig = getTransferFeeConfig(mintData);
    assert.ok(transferFeeConfig !== null);

    const epochInfo = await provider.connection.getEpochInfo();
    const transferFee = getEpochFee(transferFeeConfig, BigInt(epochInfo.epoch));
    return transferFee;
  }

  describe("collect_fees_v2, collect_protocol_fees_v2", () => {
    let fixture: WhirlpoolTestFixtureV2;
    let feeAccountA: PublicKey;
    let feeAccountB: PublicKey;

    beforeEach(async () => {
      // In same tick array - start index 22528
      const tickLowerIndex = 29440;
      const tickUpperIndex = 33536;

      const tickSpacing = TickSpacing.Standard;
      fixture = await new WhirlpoolTestFixtureV2(ctx).init({
        tokenTraitA: {
          isToken2022: true,
          hasTransferFeeExtension: true,
          transferFeeInitialBps: 500,
        }, // 5%
        tokenTraitB: {
          isToken2022: true,
          hasTransferFeeExtension: true,
          transferFeeInitialBps: 1000,
        }, // 10%
        tickSpacing,
        positions: [
          { tickLowerIndex, tickUpperIndex, liquidityAmount: new anchor.BN(10_000_000) }, // In range position
          { tickLowerIndex: 0, tickUpperIndex: 128, liquidityAmount: new anchor.BN(1_000_000) }, // Out of range position
        ],
      });
      const {
        poolInitInfo: {
          whirlpoolPda,
          tokenVaultAKeypair,
          tokenVaultBKeypair,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
        },
        tokenAccountA,
        tokenAccountB,
        positions,
      } = fixture.getInfos();

      const tickArrayPda = PDAUtil.getTickArray(
        ctx.program.programId,
        whirlpoolPda.publicKey,
        22528,
      );
      const oraclePda = PDAUtil.getOracle(ctx.program.programId, whirlpoolPda.publicKey);

      // Accrue fees in token A
      await toTx(
        ctx,
        WhirlpoolIx.swapV2Ix(ctx.program, {
          amount: new BN(200_000),
          otherAmountThreshold: ZERO_BN,
          sqrtPriceLimit: MathUtil.toX64(new Decimal(4)),
          amountSpecifiedIsInput: true,
          aToB: true,
          whirlpool: whirlpoolPda.publicKey,
          tokenAuthority: ctx.wallet.publicKey,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
          tokenOwnerAccountA: tokenAccountA,
          tokenVaultA: tokenVaultAKeypair.publicKey,
          tokenOwnerAccountB: tokenAccountB,
          tokenVaultB: tokenVaultBKeypair.publicKey,
          tickArray0: tickArrayPda.publicKey,
          tickArray1: tickArrayPda.publicKey,
          tickArray2: tickArrayPda.publicKey,
          oracle: oraclePda.publicKey,
        }),
      ).buildAndExecute();

      // Accrue fees in token B
      await toTx(
        ctx,
        WhirlpoolIx.swapV2Ix(ctx.program, {
          amount: new BN(200_000),
          otherAmountThreshold: ZERO_BN,
          sqrtPriceLimit: MathUtil.toX64(new Decimal(5)),
          amountSpecifiedIsInput: true,
          aToB: false,
          whirlpool: whirlpoolPda.publicKey,
          tokenAuthority: ctx.wallet.publicKey,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
          tokenOwnerAccountA: tokenAccountA,
          tokenVaultA: tokenVaultAKeypair.publicKey,
          tokenOwnerAccountB: tokenAccountB,
          tokenVaultB: tokenVaultBKeypair.publicKey,
          tickArray0: tickArrayPda.publicKey,
          tickArray1: tickArrayPda.publicKey,
          tickArray2: tickArrayPda.publicKey,
          oracle: oraclePda.publicKey,
        }),
      ).buildAndExecute();

      await toTx(
        ctx,
        WhirlpoolIx.updateFeesAndRewardsIx(ctx.program, {
          whirlpool: whirlpoolPda.publicKey,
          position: positions[0].publicKey,
          tickArrayLower: tickArrayPda.publicKey,
          tickArrayUpper: tickArrayPda.publicKey,
        }),
      ).buildAndExecute();

      const whirlpoolData = (await fetcher.getPool(whirlpoolPda.publicKey, IGNORE_CACHE))!;
      assert.ok(!whirlpoolData.protocolFeeOwedA.isZero());
      assert.ok(!whirlpoolData.protocolFeeOwedB.isZero());

      const positionBeforeCollect = (await fetcher.getPosition(
        positions[0].publicKey,
        IGNORE_CACHE,
      )) as PositionData;
      assert.ok(!positionBeforeCollect.feeOwedA.isZero());
      assert.ok(!positionBeforeCollect.feeOwedB.isZero());

      feeAccountA = await createTokenAccountV2(
        provider,
        { isToken2022: true },
        tokenMintA,
        provider.wallet.publicKey,
      );
      feeAccountB = await createTokenAccountV2(
        provider,
        { isToken2022: true },
        tokenMintB,
        provider.wallet.publicKey,
      );
    });

    it("collect_fees_v2: with transfer fee", async () => {
      const {
        poolInitInfo: {
          whirlpoolPda,
          tokenVaultAKeypair,
          tokenVaultBKeypair,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
        },
        positions,
      } = fixture.getInfos();

      const transferFeeA = await getTransferFee(tokenMintA);
      const transferFeeB = await getTransferFee(tokenMintB);
      assert.equal(transferFeeA.transferFeeBasisPoints, 500); // 5%
      assert.equal(transferFeeB.transferFeeBasisPoints, 1000); // 10%

      // feeOwed includes transfer fee
      const positionBeforeCollect = (await fetcher.getPosition(
        positions[0].publicKey,
        IGNORE_CACHE,
      )) as PositionData;
      assert.ok(!positionBeforeCollect.feeOwedA.isZero());
      assert.ok(!positionBeforeCollect.feeOwedB.isZero());

      // transfer fee should be non zero
      const expectedTransferFeeExcludedAmountA = calculateTransferFeeExcludedAmount(
        transferFeeA,
        positionBeforeCollect.feeOwedA,
      );
      const expectedTransferFeeExcludedAmountB = calculateTransferFeeExcludedAmount(
        transferFeeB,
        positionBeforeCollect.feeOwedB,
      );
      assert.ok(expectedTransferFeeExcludedAmountA.fee.gtn(0));
      assert.ok(expectedTransferFeeExcludedAmountB.fee.gtn(0));

      const preVaultBalanceA = await getTokenBalance(provider, tokenVaultAKeypair.publicKey);
      const preVaultBalanceB = await getTokenBalance(provider, tokenVaultBKeypair.publicKey);

      const sig = await toTx(
        ctx,
        WhirlpoolIx.collectFeesV2Ix(ctx.program, {
          whirlpool: whirlpoolPda.publicKey,
          positionAuthority: provider.wallet.publicKey,
          position: positions[0].publicKey,
          positionTokenAccount: positions[0].tokenAccount,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
          tokenOwnerAccountA: feeAccountA,
          tokenOwnerAccountB: feeAccountB,
          tokenVaultA: tokenVaultAKeypair.publicKey,
          tokenVaultB: tokenVaultBKeypair.publicKey,
        }),
      ).buildAndExecute();

      // vault sent owed only (transfer fee is paid from owed)
      const postVaultBalanceA = await getTokenBalance(provider, tokenVaultAKeypair.publicKey);
      const postVaultBalanceB = await getTokenBalance(provider, tokenVaultBKeypair.publicKey);
      assert.ok(
        new BN(preVaultBalanceA).sub(new BN(postVaultBalanceA)).eq(positionBeforeCollect.feeOwedA),
      );
      assert.ok(
        new BN(preVaultBalanceB).sub(new BN(postVaultBalanceB)).eq(positionBeforeCollect.feeOwedB),
      );

      // owner received feeOwed minus transfer fee (transferFeeExcludedAmount)
      const feeBalanceA = await getTokenBalance(provider, feeAccountA);
      const feeBalanceB = await getTokenBalance(provider, feeAccountB);
      assert.ok(new BN(feeBalanceA).eq(expectedTransferFeeExcludedAmountA.amount));
      assert.ok(new BN(feeBalanceB).eq(expectedTransferFeeExcludedAmountB.amount));

      //console.log("A", positionBeforeCollect.feeOwedA.toString(), feeBalanceA.toString(), expectedTransferFeeExcludedAmountA.amount.toString(), expectedTransferFeeExcludedAmountA.fee.toString());
      //console.log("B", positionBeforeCollect.feeOwedB.toString(), feeBalanceB.toString(), expectedTransferFeeExcludedAmountB.amount.toString(), expectedTransferFeeExcludedAmountB.fee.toString());

      // all owed amount should be collected
      const positionAfterCollect = (await fetcher.getPosition(
        positions[0].publicKey,
        IGNORE_CACHE,
      )) as PositionData;
      assert.ok(positionAfterCollect.feeOwedA.isZero());
      assert.ok(positionAfterCollect.feeOwedB.isZero());
    });

    it("collect_protocol_fees_v2: with transfer fee", async () => {
      const {
        poolInitInfo: {
          whirlpoolPda,
          tokenVaultAKeypair,
          tokenVaultBKeypair,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
        },
        configKeypairs: { collectProtocolFeesAuthorityKeypair },
        configInitInfo: { whirlpoolsConfigKeypair: whirlpoolsConfigKeypair },
      } = fixture.getInfos();

      const transferFeeA = await getTransferFee(tokenMintA);
      const transferFeeB = await getTransferFee(tokenMintB);
      assert.equal(transferFeeA.transferFeeBasisPoints, 500); // 5%
      assert.equal(transferFeeB.transferFeeBasisPoints, 1000); // 10%

      // protocolFeeOwed includes transfer fee
      const poolBeforeCollect = (await fetcher.getPool(
        whirlpoolPda.publicKey,
        IGNORE_CACHE,
      )) as WhirlpoolData;
      assert.ok(!poolBeforeCollect.protocolFeeOwedA.isZero());
      assert.ok(!poolBeforeCollect.protocolFeeOwedB.isZero());

      // transfer fee should be non zero
      const expectedTransferFeeExcludedAmountA = calculateTransferFeeExcludedAmount(
        transferFeeA,
        poolBeforeCollect.protocolFeeOwedA,
      );
      const expectedTransferFeeExcludedAmountB = calculateTransferFeeExcludedAmount(
        transferFeeB,
        poolBeforeCollect.protocolFeeOwedB,
      );
      assert.ok(expectedTransferFeeExcludedAmountA.fee.gtn(0));
      assert.ok(expectedTransferFeeExcludedAmountB.fee.gtn(0));

      const preVaultBalanceA = await getTokenBalance(provider, tokenVaultAKeypair.publicKey);
      const preVaultBalanceB = await getTokenBalance(provider, tokenVaultBKeypair.publicKey);

      const sig = await toTx(
        ctx,
        WhirlpoolIx.collectProtocolFeesV2Ix(ctx.program, {
          whirlpoolsConfig: whirlpoolsConfigKeypair.publicKey,
          whirlpool: whirlpoolPda.publicKey,
          collectProtocolFeesAuthority: collectProtocolFeesAuthorityKeypair.publicKey,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
          tokenVaultA: tokenVaultAKeypair.publicKey,
          tokenVaultB: tokenVaultBKeypair.publicKey,
          tokenOwnerAccountA: feeAccountA,
          tokenOwnerAccountB: feeAccountB,
        }),
      )
        .addSigner(collectProtocolFeesAuthorityKeypair)
        .buildAndExecute();

      // vault sent owed only (transfer fee is paid from owed)
      const postVaultBalanceA = await getTokenBalance(provider, tokenVaultAKeypair.publicKey);
      const postVaultBalanceB = await getTokenBalance(provider, tokenVaultBKeypair.publicKey);
      assert.ok(
        new BN(preVaultBalanceA)
          .sub(new BN(postVaultBalanceA))
          .eq(poolBeforeCollect.protocolFeeOwedA),
      );
      assert.ok(
        new BN(preVaultBalanceB)
          .sub(new BN(postVaultBalanceB))
          .eq(poolBeforeCollect.protocolFeeOwedB),
      );

      // protocol received feeOwed minus transfer fee (transferFeeExcludedAmount)
      const feeBalanceA = await getTokenBalance(provider, feeAccountA);
      const feeBalanceB = await getTokenBalance(provider, feeAccountB);
      assert.ok(new BN(feeBalanceA).eq(expectedTransferFeeExcludedAmountA.amount));
      assert.ok(new BN(feeBalanceB).eq(expectedTransferFeeExcludedAmountB.amount));

      // all owed amount should be collected
      const poolAfterCollect = (await fetcher.getPool(
        whirlpoolPda.publicKey,
        IGNORE_CACHE,
      )) as WhirlpoolData;
      assert.ok(poolAfterCollect.protocolFeeOwedA.isZero());
      assert.ok(poolAfterCollect.protocolFeeOwedB.isZero());
    });
  });

  describe("collect_reward_v2", () => {
    let fixture: WhirlpoolTestFixtureV2;
    let rewardAccounts: PublicKey[];

    beforeEach(async () => {
      const vaultStartBalance = 1_000_000;
      const lowerTickIndex = -1280,
        upperTickIndex = 1280,
        tickSpacing = TickSpacing.Standard;
      fixture = await new WhirlpoolTestFixtureV2(ctx).init({
        tokenTraitA: { isToken2022: true },
        tokenTraitB: { isToken2022: true },
        tickSpacing: tickSpacing,
        initialSqrtPrice: MathUtil.toX64(new Decimal(1)),
        positions: [
          {
            tickLowerIndex: lowerTickIndex,
            tickUpperIndex: upperTickIndex,
            liquidityAmount: new anchor.BN(1_000_000),
          },
        ],
        rewards: [
          {
            rewardTokenTrait: {
              isToken2022: true,
              hasTransferFeeExtension: true,
              transferFeeInitialBps: 500,
            }, // 5%
            emissionsPerSecondX64: MathUtil.toX64(new Decimal(10)),
            vaultAmount: new BN(vaultStartBalance),
          },
          {
            rewardTokenTrait: {
              isToken2022: true,
              hasTransferFeeExtension: true,
              transferFeeInitialBps: 1000,
            }, // 10%
            emissionsPerSecondX64: MathUtil.toX64(new Decimal(10)),
            vaultAmount: new BN(vaultStartBalance),
          },
          {
            rewardTokenTrait: {
              isToken2022: true,
              hasTransferFeeExtension: true,
              transferFeeInitialBps: 5000,
            }, // 50%
            emissionsPerSecondX64: MathUtil.toX64(new Decimal(10)),
            vaultAmount: new BN(vaultStartBalance),
          },
        ],
      });
      const {
        poolInitInfo: { whirlpoolPda },
        positions,
        rewards,
      } = fixture.getInfos();

      // accrue rewards
      await sleep(1200);

      await toTx(
        ctx,
        WhirlpoolIx.updateFeesAndRewardsIx(ctx.program, {
          whirlpool: whirlpoolPda.publicKey,
          position: positions[0].publicKey,
          tickArrayLower: positions[0].tickArrayLower,
          tickArrayUpper: positions[0].tickArrayUpper,
        }),
      ).buildAndExecute();

      // Generate collect reward expectation
      const whirlpoolData = (await fetcher.getPool(whirlpoolPda.publicKey)) as WhirlpoolData;
      const positionPreCollect = await client.getPosition(positions[0].publicKey, IGNORE_CACHE);

      // Lock the collectRewards quote to the last time we called updateFeesAndRewards
      const expectation = collectRewardsQuote({
        whirlpool: whirlpoolData,
        position: positionPreCollect.getData(),
        tickLower: positionPreCollect.getLowerTickData(),
        tickUpper: positionPreCollect.getUpperTickData(),
        timeStampInSeconds: whirlpoolData.rewardLastUpdatedTimestamp,
      });

      // Check that the expectation is not zero
      for (let i = 0; i < NUM_REWARDS; i++) {
        assert.ok(!expectation[i]!.isZero());
      }

      rewardAccounts = await Promise.all(
        rewards.map((reward) => {
          return createTokenAccountV2(
            provider,
            { isToken2022: true },
            reward.rewardMint,
            provider.wallet.publicKey,
          );
        }),
      );
    });

    it("collect_reward_v2: with transfer fee", async () => {
      const {
        poolInitInfo: { whirlpoolPda },
        positions,
        rewards,
      } = fixture.getInfos();

      const whirlpoolData = (await fetcher.getPool(whirlpoolPda.publicKey)) as WhirlpoolData;
      const positionPreCollect = await client.getPosition(positions[0].publicKey, IGNORE_CACHE);
      const expectation = collectRewardsQuote({
        whirlpool: whirlpoolData,
        position: positionPreCollect.getData(),
        tickLower: positionPreCollect.getLowerTickData(),
        tickUpper: positionPreCollect.getUpperTickData(),
        timeStampInSeconds: whirlpoolData.rewardLastUpdatedTimestamp,
      });

      for (let i = 0; i < NUM_REWARDS; i++) {
        const transferFee = await getTransferFee(rewards[i].rewardMint);
        assert.equal(transferFee.transferFeeBasisPoints, [500, 1000, 5000][i]);

        // expectation include transfer fee
        const expectedTransferFeeExcludedAmount = calculateTransferFeeExcludedAmount(
          transferFee,
          expectation[i]!,
        );
        assert.ok(expectedTransferFeeExcludedAmount.fee.gtn(0));

        const preVaultBalance = await getTokenBalance(
          provider,
          rewards[i].rewardVaultKeypair.publicKey,
        );

        const sig = await toTx(
          ctx,
          WhirlpoolIx.collectRewardV2Ix(ctx.program, {
            whirlpool: whirlpoolPda.publicKey,
            positionAuthority: provider.wallet.publicKey,
            position: positions[0].publicKey,
            positionTokenAccount: positions[0].tokenAccount,
            rewardMint: rewards[i].rewardMint,
            rewardTokenProgram: rewards[i].tokenProgram,
            rewardOwnerAccount: rewardAccounts[i],
            rewardVault: rewards[i].rewardVaultKeypair.publicKey,
            rewardIndex: i,
          }),
        ).buildAndExecute();

        // vault sent owed only (no transfer fee, transfer fee is paid from owed)
        const postVaultBalance = await getTokenBalance(
          provider,
          rewards[i].rewardVaultKeypair.publicKey,
        );
        assert.ok(new BN(preVaultBalance).sub(new BN(postVaultBalance)).eq(expectation[i]!));

        // owner received expectation minus transfer fee (transferFeeExcludedAmount)
        const rewardBalance = await getTokenBalance(provider, rewardAccounts[i]);
        assert.ok(new BN(rewardBalance).eq(expectedTransferFeeExcludedAmount.amount));

        //console.log("R", expectation[i]?.toString(), rewardBalance.toString(), expectedTransferFeeExcludedAmount.amount.toString(), expectedTransferFeeExcludedAmount.fee.toString());
      }

      const positionPostCollect = await client.getPosition(positions[0].publicKey, IGNORE_CACHE);
      const expectationPostCollect = collectRewardsQuote({
        whirlpool: whirlpoolData,
        position: positionPostCollect.getData(),
        tickLower: positionPostCollect.getLowerTickData(),
        tickUpper: positionPostCollect.getUpperTickData(),
        timeStampInSeconds: whirlpoolData.rewardLastUpdatedTimestamp,
      });

      assert.ok(expectationPostCollect.every((n) => n!.isZero()));
    });
  });

  describe("increase_liquidity_v2", () => {
    const tickLowerIndex = 7168;
    const tickUpperIndex = 8960;
    const currTick = Math.round((tickLowerIndex + tickUpperIndex) / 2);

    let fixture: WhirlpoolTestFixtureV2;

    beforeEach(async () => {
      fixture = await new WhirlpoolTestFixtureV2(ctx).init({
        tokenTraitA: {
          isToken2022: true,
          hasTransferFeeExtension: true,
          transferFeeInitialBps: 500,
        }, // 5%
        tokenTraitB: {
          isToken2022: true,
          hasTransferFeeExtension: true,
          transferFeeInitialBps: 1000,
        }, // 10%
        tickSpacing: TickSpacing.Standard,
        positions: [{ tickLowerIndex, tickUpperIndex, liquidityAmount: ZERO_BN }],
        initialSqrtPrice: PriceMath.tickIndexToSqrtPriceX64(currTick),
      });
    });

    it("increase_liquidity_v2: with transfer fee", async () => {
      const { poolInitInfo, positions, tokenAccountA, tokenAccountB } = fixture.getInfos();
      const positionInitInfo = positions[0];

      const transferFeeA = await getTransferFee(poolInitInfo.tokenMintA);
      const transferFeeB = await getTransferFee(poolInitInfo.tokenMintB);
      assert.equal(transferFeeA.transferFeeBasisPoints, 500); // 5%
      assert.equal(transferFeeB.transferFeeBasisPoints, 1000); // 10%

      const tokenAmount = toTokenAmount(1_000_000 * 0.8, 1_000_000 * 0.8);
      const liquidityAmount = PoolUtil.estimateLiquidityFromTokenAmounts(
        currTick,
        tickLowerIndex,
        tickUpperIndex,
        tokenAmount,
      );
      const requiredAmountDelta = PoolUtil.getTokenAmountsFromLiquidity(
        liquidityAmount,
        PriceMath.tickIndexToSqrtPriceX64(currTick),
        PriceMath.tickIndexToSqrtPriceX64(tickLowerIndex),
        PriceMath.tickIndexToSqrtPriceX64(tickUpperIndex),
        true,
      );

      // transfer fee should be non zero
      assert.ok(requiredAmountDelta.tokenA.gtn(0));
      assert.ok(requiredAmountDelta.tokenB.gtn(0));
      const expectedTransferFeeIncludedAmountA = calculateTransferFeeIncludedAmount(
        transferFeeA,
        requiredAmountDelta.tokenA,
      );
      const expectedTransferFeeIncludedAmountB = calculateTransferFeeIncludedAmount(
        transferFeeB,
        requiredAmountDelta.tokenB,
      );
      assert.ok(expectedTransferFeeIncludedAmountA.fee.gtn(0));
      assert.ok(expectedTransferFeeIncludedAmountB.fee.gtn(0));

      const preVaultBalanceA = new BN(
        await getTokenBalance(provider, poolInitInfo.tokenVaultAKeypair.publicKey),
      );
      const preVaultBalanceB = new BN(
        await getTokenBalance(provider, poolInitInfo.tokenVaultBKeypair.publicKey),
      );
      const preOwnerAccountBalanceA = new BN(await getTokenBalance(provider, tokenAccountA));
      const preOwnerAccountBalanceB = new BN(await getTokenBalance(provider, tokenAccountB));

      await toTx(
        ctx,
        WhirlpoolIx.increaseLiquidityV2Ix(ctx.program, {
          liquidityAmount,
          tokenMaxA: expectedTransferFeeIncludedAmountA.amount,
          tokenMaxB: expectedTransferFeeIncludedAmountB.amount,
          whirlpool: poolInitInfo.whirlpoolPda.publicKey,
          positionAuthority: provider.wallet.publicKey,
          position: positionInitInfo.publicKey,
          positionTokenAccount: positionInitInfo.tokenAccount,
          tokenMintA: poolInitInfo.tokenMintA,
          tokenMintB: poolInitInfo.tokenMintB,
          tokenProgramA: poolInitInfo.tokenProgramA,
          tokenProgramB: poolInitInfo.tokenProgramB,
          tokenOwnerAccountA: tokenAccountA,
          tokenOwnerAccountB: tokenAccountB,
          tokenVaultA: poolInitInfo.tokenVaultAKeypair.publicKey,
          tokenVaultB: poolInitInfo.tokenVaultBKeypair.publicKey,
          tickArrayLower: positionInitInfo.tickArrayLower,
          tickArrayUpper: positionInitInfo.tickArrayUpper,
        }),
      ).buildAndExecute();

      const postVaultBalanceA = new BN(
        await getTokenBalance(provider, poolInitInfo.tokenVaultAKeypair.publicKey),
      );
      const postVaultBalanceB = new BN(
        await getTokenBalance(provider, poolInitInfo.tokenVaultBKeypair.publicKey),
      );
      const postOwnerAccountBalanceA = new BN(await getTokenBalance(provider, tokenAccountA));
      const postOwnerAccountBalanceB = new BN(await getTokenBalance(provider, tokenAccountB));

      // owner sent requiredAmountDelta plus transfer fees
      assert.ok(
        preOwnerAccountBalanceA
          .sub(postOwnerAccountBalanceA)
          .eq(expectedTransferFeeIncludedAmountA.amount),
      );
      assert.ok(
        preOwnerAccountBalanceB
          .sub(postOwnerAccountBalanceB)
          .eq(expectedTransferFeeIncludedAmountB.amount),
      );
      // vault received requiredAmountDelta
      assert.ok(postVaultBalanceA.sub(preVaultBalanceA).eq(requiredAmountDelta.tokenA));
      assert.ok(postVaultBalanceB.sub(preVaultBalanceB).eq(requiredAmountDelta.tokenB));
    });

    it("increase_liquidity_v2: [FAIL] TokenMaxExceeded due to transfer fee", async () => {
      const { poolInitInfo, positions, tokenAccountA, tokenAccountB } = fixture.getInfos();
      const positionInitInfo = positions[0];

      const transferFeeA = await getTransferFee(poolInitInfo.tokenMintA);
      const transferFeeB = await getTransferFee(poolInitInfo.tokenMintB);
      assert.equal(transferFeeA.transferFeeBasisPoints, 500); // 5%
      assert.equal(transferFeeB.transferFeeBasisPoints, 1000); // 10%

      const tokenAmount = toTokenAmount(1_000_000 * 0.8, 1_000_000 * 0.8);
      const liquidityAmount = PoolUtil.estimateLiquidityFromTokenAmounts(
        currTick,
        tickLowerIndex,
        tickUpperIndex,
        tokenAmount,
      );
      const requiredAmountDelta = PoolUtil.getTokenAmountsFromLiquidity(
        liquidityAmount,
        PriceMath.tickIndexToSqrtPriceX64(currTick),
        PriceMath.tickIndexToSqrtPriceX64(tickLowerIndex),
        PriceMath.tickIndexToSqrtPriceX64(tickUpperIndex),
        true,
      );

      // transfer fee should be non zero
      assert.ok(requiredAmountDelta.tokenA.gtn(0));
      assert.ok(requiredAmountDelta.tokenB.gtn(0));
      const expectedTransferFeeIncludedAmountA = calculateTransferFeeIncludedAmount(
        transferFeeA,
        requiredAmountDelta.tokenA,
      );
      const expectedTransferFeeIncludedAmountB = calculateTransferFeeIncludedAmount(
        transferFeeB,
        requiredAmountDelta.tokenB,
      );
      assert.ok(expectedTransferFeeIncludedAmountA.fee.gtn(0));
      assert.ok(expectedTransferFeeIncludedAmountB.fee.gtn(0));

      const normalParams: IncreaseLiquidityV2Params = {
        liquidityAmount,
        tokenMaxA: expectedTransferFeeIncludedAmountA.amount,
        tokenMaxB: expectedTransferFeeIncludedAmountB.amount,
        whirlpool: poolInitInfo.whirlpoolPda.publicKey,
        positionAuthority: provider.wallet.publicKey,
        position: positionInitInfo.publicKey,
        positionTokenAccount: positionInitInfo.tokenAccount,
        tokenMintA: poolInitInfo.tokenMintA,
        tokenMintB: poolInitInfo.tokenMintB,
        tokenProgramA: poolInitInfo.tokenProgramA,
        tokenProgramB: poolInitInfo.tokenProgramB,
        tokenOwnerAccountA: tokenAccountA,
        tokenOwnerAccountB: tokenAccountB,
        tokenVaultA: poolInitInfo.tokenVaultAKeypair.publicKey,
        tokenVaultB: poolInitInfo.tokenVaultBKeypair.publicKey,
        tickArrayLower: positionInitInfo.tickArrayLower,
        tickArrayUpper: positionInitInfo.tickArrayUpper,
      };

      await assert.rejects(
        toTx(
          ctx,
          WhirlpoolIx.increaseLiquidityV2Ix(ctx.program, {
            ...normalParams,
            // TransferFee is not taken into account
            tokenMaxA: requiredAmountDelta.tokenA,
          }),
        ).buildAndExecute(),
        /0x1781/, // TokenMaxExceeded
      );

      await assert.rejects(
        toTx(
          ctx,
          WhirlpoolIx.increaseLiquidityV2Ix(ctx.program, {
            ...normalParams,
            // TransferFee is not taken into account
            tokenMaxB: requiredAmountDelta.tokenB,
          }),
        ).buildAndExecute(),
        /0x1781/, // TokenMaxExceeded
      );

      await assert.rejects(
        toTx(
          ctx,
          WhirlpoolIx.increaseLiquidityV2Ix(ctx.program, {
            ...normalParams,
            // set maxA to expected - 1
            tokenMaxA: requiredAmountDelta.tokenA
              .add(expectedTransferFeeIncludedAmountA.fee)
              .subn(1),
          }),
        ).buildAndExecute(),
        /0x1781/, // TokenMaxExceeded
      );

      await assert.rejects(
        toTx(
          ctx,
          WhirlpoolIx.increaseLiquidityV2Ix(ctx.program, {
            ...normalParams,
            // set maxB to expected - 1
            tokenMaxB: requiredAmountDelta.tokenB
              .add(expectedTransferFeeIncludedAmountB.fee)
              .subn(1),
          }),
        ).buildAndExecute(),
        /0x1781/, // TokenMaxExceeded
      );

      // success with normal params
      await toTx(
        ctx,
        WhirlpoolIx.increaseLiquidityV2Ix(ctx.program, normalParams),
      ).buildAndExecute();
    });
  });

  describe("decrease_liquidity_v2", () => {
    let fixture: WhirlpoolTestFixtureV2;
    let destAccountA: PublicKey;
    let destAccountB: PublicKey;

    beforeEach(async () => {
      const liquidityAmount = new anchor.BN(1_250_000);
      const tickLower = 7168,
        tickUpper = 8960;
      fixture = await new WhirlpoolTestFixtureV2(ctx).init({
        tokenTraitA: {
          isToken2022: true,
          hasTransferFeeExtension: true,
          transferFeeInitialBps: 500,
        }, // 5%
        tokenTraitB: {
          isToken2022: true,
          hasTransferFeeExtension: true,
          transferFeeInitialBps: 1000,
        }, // 10%
        tickSpacing: TickSpacing.Standard,
        initialSqrtPrice: MathUtil.toX64(new Decimal(1.48)),
        positions: [{ tickLowerIndex: tickLower, tickUpperIndex: tickUpper, liquidityAmount }],
      });
      const { poolInitInfo } = fixture.getInfos();

      destAccountA = await createTokenAccountV2(
        provider,
        { isToken2022: true },
        poolInitInfo.tokenMintA,
        provider.wallet.publicKey,
      );
      destAccountB = await createTokenAccountV2(
        provider,
        { isToken2022: true },
        poolInitInfo.tokenMintB,
        provider.wallet.publicKey,
      );
    });

    it("decrease_liquidity_v2: with transfer fee", async () => {
      const { poolInitInfo, positions } = fixture.getInfos();

      const transferFeeA = await getTransferFee(poolInitInfo.tokenMintA);
      const transferFeeB = await getTransferFee(poolInitInfo.tokenMintB);
      assert.equal(transferFeeA.transferFeeBasisPoints, 500); // 5%
      assert.equal(transferFeeB.transferFeeBasisPoints, 1000); // 10%

      const position = positions[0];
      const positionData = (await fetcher.getPosition(
        position.publicKey,
        IGNORE_CACHE,
      )) as PositionData;
      const whirlpoolData = (await fetcher.getPool(
        positionData.whirlpool,
        IGNORE_CACHE,
      )) as WhirlpoolData;
      const expectedAmount = PoolUtil.getTokenAmountsFromLiquidity(
        positionData.liquidity,
        whirlpoolData.sqrtPrice,
        PriceMath.tickIndexToSqrtPriceX64(positionData.tickLowerIndex),
        PriceMath.tickIndexToSqrtPriceX64(positionData.tickUpperIndex),
        false,
      );

      // transfer fee should be non zero
      assert.ok(expectedAmount.tokenA.gtn(0));
      assert.ok(expectedAmount.tokenB.gtn(0));
      const expectedTransferFeeExcludedAmountA = calculateTransferFeeExcludedAmount(
        transferFeeA,
        expectedAmount.tokenA,
      );
      const expectedTransferFeeExcludedAmountB = calculateTransferFeeExcludedAmount(
        transferFeeB,
        expectedAmount.tokenB,
      );
      assert.ok(expectedTransferFeeExcludedAmountA.fee.gtn(0));
      assert.ok(expectedTransferFeeExcludedAmountB.fee.gtn(0));

      const preVaultBalanceA = await getTokenBalance(
        provider,
        poolInitInfo.tokenVaultAKeypair.publicKey,
      );
      const preVaultBalanceB = await getTokenBalance(
        provider,
        poolInitInfo.tokenVaultBKeypair.publicKey,
      );

      const sig = await toTx(
        ctx,
        WhirlpoolIx.decreaseLiquidityV2Ix(ctx.program, {
          liquidityAmount: positionData.liquidity,
          tokenMinA: expectedAmount.tokenA.sub(expectedTransferFeeExcludedAmountA.fee),
          tokenMinB: expectedAmount.tokenB.sub(expectedTransferFeeExcludedAmountB.fee),
          whirlpool: poolInitInfo.whirlpoolPda.publicKey,
          positionAuthority: provider.wallet.publicKey,
          position: position.publicKey,
          positionTokenAccount: position.tokenAccount,
          tokenMintA: poolInitInfo.tokenMintA,
          tokenMintB: poolInitInfo.tokenMintB,
          tokenProgramA: poolInitInfo.tokenProgramA,
          tokenProgramB: poolInitInfo.tokenProgramB,
          tokenOwnerAccountA: destAccountA,
          tokenOwnerAccountB: destAccountB,
          tokenVaultA: poolInitInfo.tokenVaultAKeypair.publicKey,
          tokenVaultB: poolInitInfo.tokenVaultBKeypair.publicKey,
          tickArrayLower: position.tickArrayLower,
          tickArrayUpper: position.tickArrayUpper,
        }),
      ).buildAndExecute();

      const postVaultBalanceA = await getTokenBalance(
        provider,
        poolInitInfo.tokenVaultAKeypair.publicKey,
      );
      const postVaultBalanceB = await getTokenBalance(
        provider,
        poolInitInfo.tokenVaultBKeypair.publicKey,
      );
      assert.ok(new BN(preVaultBalanceA).sub(new BN(postVaultBalanceA)).eq(expectedAmount.tokenA));
      assert.ok(new BN(preVaultBalanceB).sub(new BN(postVaultBalanceB)).eq(expectedAmount.tokenB));

      // owner received withdrawable amount minus transfer fee (transferFeeExcludedAmount)
      const destBalanceA = await getTokenBalance(provider, destAccountA);
      const destBalanceB = await getTokenBalance(provider, destAccountB);
      //console.log("A", destBalanceA.toString(), expectedTransferFeeExcludedAmountA.amount.toString(), expectedTransferFeeExcludedAmountA.fee.toString());
      //console.log("B", destBalanceB.toString(), expectedTransferFeeExcludedAmountB.amount.toString(), expectedTransferFeeExcludedAmountB.fee.toString());

      assert.ok(new BN(destBalanceA).eq(expectedTransferFeeExcludedAmountA.amount));
      assert.ok(new BN(destBalanceB).eq(expectedTransferFeeExcludedAmountB.amount));

      // all liquidity have been decreased
      const positionDataAfterWithdraw = (await fetcher.getPosition(
        position.publicKey,
        IGNORE_CACHE,
      )) as PositionData;
      assert.ok(positionDataAfterWithdraw.liquidity.isZero());
    });

    it("decrease_liquidity_v2: [FAIL] TokenMinSubceeded due to transfer fee", async () => {
      const { poolInitInfo, positions } = fixture.getInfos();

      const transferFeeA = await getTransferFee(poolInitInfo.tokenMintA);
      const transferFeeB = await getTransferFee(poolInitInfo.tokenMintB);
      assert.equal(transferFeeA.transferFeeBasisPoints, 500); // 5%
      assert.equal(transferFeeB.transferFeeBasisPoints, 1000); // 10%

      const position = positions[0];
      const positionData = (await fetcher.getPosition(
        position.publicKey,
        IGNORE_CACHE,
      )) as PositionData;
      const whirlpoolData = (await fetcher.getPool(
        positionData.whirlpool,
        IGNORE_CACHE,
      )) as WhirlpoolData;
      const expectedAmount = PoolUtil.getTokenAmountsFromLiquidity(
        positionData.liquidity,
        whirlpoolData.sqrtPrice,
        PriceMath.tickIndexToSqrtPriceX64(positionData.tickLowerIndex),
        PriceMath.tickIndexToSqrtPriceX64(positionData.tickUpperIndex),
        false,
      );

      // transfer fee should be non zero
      assert.ok(expectedAmount.tokenA.gtn(0));
      assert.ok(expectedAmount.tokenB.gtn(0));
      const expectedTransferFeeExcludedAmountA = calculateTransferFeeExcludedAmount(
        transferFeeA,
        expectedAmount.tokenA,
      );
      const expectedTransferFeeExcludedAmountB = calculateTransferFeeExcludedAmount(
        transferFeeB,
        expectedAmount.tokenB,
      );
      assert.ok(expectedTransferFeeExcludedAmountA.fee.gtn(0));
      assert.ok(expectedTransferFeeExcludedAmountB.fee.gtn(0));

      const normalParams: DecreaseLiquidityV2Params = {
        liquidityAmount: positionData.liquidity,
        tokenMinA: expectedAmount.tokenA.sub(expectedTransferFeeExcludedAmountA.fee),
        tokenMinB: expectedAmount.tokenB.sub(expectedTransferFeeExcludedAmountB.fee),
        whirlpool: poolInitInfo.whirlpoolPda.publicKey,
        positionAuthority: provider.wallet.publicKey,
        position: position.publicKey,
        positionTokenAccount: position.tokenAccount,
        tokenMintA: poolInitInfo.tokenMintA,
        tokenMintB: poolInitInfo.tokenMintB,
        tokenProgramA: poolInitInfo.tokenProgramA,
        tokenProgramB: poolInitInfo.tokenProgramB,
        tokenOwnerAccountA: destAccountA,
        tokenOwnerAccountB: destAccountB,
        tokenVaultA: poolInitInfo.tokenVaultAKeypair.publicKey,
        tokenVaultB: poolInitInfo.tokenVaultBKeypair.publicKey,
        tickArrayLower: position.tickArrayLower,
        tickArrayUpper: position.tickArrayUpper,
      };

      await assert.rejects(
        toTx(
          ctx,
          WhirlpoolIx.decreaseLiquidityV2Ix(ctx.program, {
            ...normalParams,
            // TransferFee is not taken into account
            tokenMinA: expectedAmount.tokenA,
          }),
        ).buildAndExecute(),
        /0x1782/, // TokenMinSubceeded
      );

      await assert.rejects(
        toTx(
          ctx,
          WhirlpoolIx.decreaseLiquidityV2Ix(ctx.program, {
            ...normalParams,
            // TransferFee is not taken into account
            tokenMinB: expectedAmount.tokenB,
          }),
        ).buildAndExecute(),
        /0x1782/, // TokenMinSubceeded
      );

      await assert.rejects(
        toTx(
          ctx,
          WhirlpoolIx.decreaseLiquidityV2Ix(ctx.program, {
            ...normalParams,
            // set minA to expected + 1
            tokenMinA: expectedAmount.tokenA.sub(expectedTransferFeeExcludedAmountA.fee).addn(1),
          }),
        ).buildAndExecute(),
        /0x1782/, // TokenMinSubceeded
      );

      await assert.rejects(
        toTx(
          ctx,
          WhirlpoolIx.decreaseLiquidityV2Ix(ctx.program, {
            ...normalParams,
            // set minB to expected + 1
            tokenMinB: expectedAmount.tokenB.sub(expectedTransferFeeExcludedAmountB.fee).addn(1),
          }),
        ).buildAndExecute(),
        /0x1782/, // TokenMinSubceeded
      );

      // success with normal params
      await toTx(
        ctx,
        WhirlpoolIx.decreaseLiquidityV2Ix(ctx.program, normalParams),
      ).buildAndExecute();
    });
  });

  describe("swap_v2", () => {
    let poolInitInfo: InitPoolV2Params;
    let whirlpoolPda: PDA;
    let transferFeeA: TransferFee | null;
    let transferFeeB: TransferFee | null;
    let tokenAccountA: PublicKey;
    let tokenAccountB: PublicKey;
    let oraclePubkey: PublicKey;

    const variations: { tokenA: TokenTrait; tokenB: TokenTrait }[] = [
      // both A & B has transfer fee
      {
        tokenA: { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 500 },
        tokenB: { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 1000 },
      },
      // only A has transfer fee
      {
        tokenA: { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 500 },
        tokenB: { isToken2022: true, hasTransferFeeExtension: false },
      },
      // only B has transfer fee
      {
        tokenA: { isToken2022: true, hasTransferFeeExtension: false },
        tokenB: { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 1000 },
      },
      // both A & B has transfer fee extension, but bps is zero
      {
        tokenA: { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 0 },
        tokenB: { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 0 },
      },
    ];

    variations.forEach(({ tokenA, tokenB }) => {
      const labelA = `TokenA: transfer fee bps = ${
        tokenA.hasTransferFeeExtension ? tokenA.transferFeeInitialBps?.toString() : "none"
      }`;
      const labelB = `TokenB: transfer fee bps = ${
        tokenB.hasTransferFeeExtension ? tokenB.transferFeeInitialBps?.toString() : "none"
      }`;
      describe(`${labelA}, ${labelB}`, () => {
        beforeEach(async () => {
          const init = await initTestPoolWithTokensV2(ctx, tokenA, tokenB, TickSpacing.Standard);
          poolInitInfo = init.poolInitInfo;
          whirlpoolPda = init.whirlpoolPda;
          tokenAccountA = init.tokenAccountA;
          tokenAccountB = init.tokenAccountB;

          const aToB = false;
          await initTickArrayRange(
            ctx,
            whirlpoolPda.publicKey,
            22528, // to 33792
            3,
            TickSpacing.Standard,
            aToB,
          );

          const fundParams: FundedPositionV2Params[] = [
            {
              liquidityAmount: new anchor.BN(10_000_000),
              tickLowerIndex: 29440,
              tickUpperIndex: 33536,
            },
          ];

          await fundPositionsV2(ctx, poolInitInfo, tokenAccountA, tokenAccountB, fundParams);
          oraclePubkey = PDAUtil.getOracle(ctx.program.programId, whirlpoolPda.publicKey).publicKey;

          transferFeeA = tokenA.hasTransferFeeExtension
            ? await getTransferFee(poolInitInfo.tokenMintA)
            : null;
          transferFeeB = tokenB.hasTransferFeeExtension
            ? await getTransferFee(poolInitInfo.tokenMintB)
            : null;

          if (transferFeeA)
            assert.equal(transferFeeA.transferFeeBasisPoints, tokenA.transferFeeInitialBps!);
          if (transferFeeB)
            assert.equal(transferFeeB.transferFeeBasisPoints, tokenB.transferFeeInitialBps!);
        });

        it("A --> B, ExactIn", async () => {
          const whirlpoolKey = poolInitInfo.whirlpoolPda.publicKey;
          const whirlpoolData = (await fetcher.getPool(
            whirlpoolKey,
            IGNORE_CACHE,
          )) as WhirlpoolData;

          const aToB = true;
          const inputAmount = new BN(100000);
          const transferFeeExcludedInputAmount = transferFeeA
            ? calculateTransferFeeExcludedAmount(transferFeeA, inputAmount)
            : { amount: inputAmount, fee: ZERO_BN };
          if (transferFeeA && transferFeeA.transferFeeBasisPoints > 0)
            assert.ok(transferFeeExcludedInputAmount.fee.gtn(0));

          const quoteAToB = swapQuoteWithParams(
            {
              // A --> B, ExactIn
              amountSpecifiedIsInput: true,
              aToB,
              tokenAmount: transferFeeExcludedInputAmount.amount,

              otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(true),
              sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToB),
              whirlpoolData,
              tickArrays: await SwapUtils.getTickArrays(
                whirlpoolData.tickCurrentIndex,
                whirlpoolData.tickSpacing,
                aToB,
                ctx.program.programId,
                whirlpoolKey,
                fetcher,
                IGNORE_CACHE,
              ),
            },
            Percentage.fromFraction(0, 100), // 0% slippage
          );

          const transferFeeExcludedOutputAmount = transferFeeB
            ? calculateTransferFeeExcludedAmount(transferFeeB, quoteAToB.estimatedAmountOut)
            : { amount: quoteAToB.estimatedAmountOut, fee: ZERO_BN };
          if (transferFeeB && transferFeeB.transferFeeBasisPoints > 0)
            assert.ok(transferFeeExcludedOutputAmount.fee.gtn(0));

          const expectedOwnerAccountADelta = inputAmount.neg(); // out
          const expectedOwnerAccountBDelta = transferFeeExcludedOutputAmount.amount; // in
          const expectedVaultAccountADelta = transferFeeExcludedInputAmount.amount; // in
          const expectedVaultAccountBDelta = quoteAToB.estimatedAmountOut.neg(); // out
          assert.ok(expectedVaultAccountADelta.eq(quoteAToB.estimatedAmountIn));
          assert.ok(expectedVaultAccountBDelta.eq(quoteAToB.estimatedAmountOut.neg()));

          const preVaultBalanceA = new BN(
            await getTokenBalance(provider, poolInitInfo.tokenVaultAKeypair.publicKey),
          );
          const preVaultBalanceB = new BN(
            await getTokenBalance(provider, poolInitInfo.tokenVaultBKeypair.publicKey),
          );
          const preOwnerAccountBalanceA = new BN(await getTokenBalance(provider, tokenAccountA));
          const preOwnerAccountBalanceB = new BN(await getTokenBalance(provider, tokenAccountB));

          const sigAToB = await toTx(
            ctx,
            WhirlpoolIx.swapV2Ix(ctx.program, {
              ...quoteAToB,
              amount: inputAmount, // transfer fee included
              otherAmountThreshold: transferFeeExcludedOutputAmount.amount, // transfer fee excluded

              whirlpool: whirlpoolPda.publicKey,
              tokenAuthority: ctx.wallet.publicKey,
              tokenMintA: poolInitInfo.tokenMintA,
              tokenMintB: poolInitInfo.tokenMintB,
              tokenProgramA: poolInitInfo.tokenProgramA,
              tokenProgramB: poolInitInfo.tokenProgramB,
              tokenOwnerAccountA: tokenAccountA,
              tokenVaultA: poolInitInfo.tokenVaultAKeypair.publicKey,
              tokenOwnerAccountB: tokenAccountB,
              tokenVaultB: poolInitInfo.tokenVaultBKeypair.publicKey,
              oracle: oraclePubkey,
            }),
          ).buildAndExecute();

          const postVaultBalanceA = new BN(
            await getTokenBalance(provider, poolInitInfo.tokenVaultAKeypair.publicKey),
          );
          const postVaultBalanceB = new BN(
            await getTokenBalance(provider, poolInitInfo.tokenVaultBKeypair.publicKey),
          );
          const postOwnerAccountBalanceA = new BN(await getTokenBalance(provider, tokenAccountA));
          const postOwnerAccountBalanceB = new BN(await getTokenBalance(provider, tokenAccountB));

          assert.ok(postVaultBalanceA.sub(preVaultBalanceA).eq(expectedVaultAccountADelta));
          assert.ok(postVaultBalanceB.sub(preVaultBalanceB).eq(expectedVaultAccountBDelta));
          assert.ok(
            postOwnerAccountBalanceA.sub(preOwnerAccountBalanceA).eq(expectedOwnerAccountADelta),
          );
          assert.ok(
            postOwnerAccountBalanceB.sub(preOwnerAccountBalanceB).eq(expectedOwnerAccountBDelta),
          );
        });

        it("A <-- B, ExactIn", async () => {
          const whirlpoolKey = poolInitInfo.whirlpoolPda.publicKey;
          const whirlpoolData = (await fetcher.getPool(
            whirlpoolKey,
            IGNORE_CACHE,
          )) as WhirlpoolData;

          const aToB = false;
          const inputAmount = new BN(100000);
          const transferFeeExcludedInputAmount = transferFeeB
            ? calculateTransferFeeExcludedAmount(transferFeeB, inputAmount)
            : { amount: inputAmount, fee: ZERO_BN };
          if (transferFeeB && transferFeeB.transferFeeBasisPoints > 0)
            assert.ok(transferFeeExcludedInputAmount.fee.gtn(0));

          const quoteBToA = swapQuoteWithParams(
            {
              // A <-- B, ExactIn
              amountSpecifiedIsInput: true,
              aToB,
              tokenAmount: transferFeeExcludedInputAmount.amount,

              otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(true),
              sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToB),
              whirlpoolData,
              tickArrays: await SwapUtils.getTickArrays(
                whirlpoolData.tickCurrentIndex,
                whirlpoolData.tickSpacing,
                aToB,
                ctx.program.programId,
                whirlpoolKey,
                fetcher,
                IGNORE_CACHE,
              ),
            },
            Percentage.fromFraction(0, 100), // 0% slippage
          );

          const transferFeeExcludedOutputAmount = transferFeeA
            ? calculateTransferFeeExcludedAmount(transferFeeA, quoteBToA.estimatedAmountOut)
            : { amount: quoteBToA.estimatedAmountOut, fee: ZERO_BN };
          if (transferFeeA && transferFeeA.transferFeeBasisPoints > 0)
            assert.ok(transferFeeExcludedOutputAmount.fee.gtn(0));

          const expectedOwnerAccountADelta = transferFeeExcludedOutputAmount.amount; // in
          const expectedOwnerAccountBDelta = inputAmount.neg(); // out
          const expectedVaultAccountADelta = quoteBToA.estimatedAmountOut.neg(); // out
          const expectedVaultAccountBDelta = transferFeeExcludedInputAmount.amount; // in
          assert.ok(expectedVaultAccountADelta.eq(quoteBToA.estimatedAmountOut.neg()));
          assert.ok(expectedVaultAccountBDelta.eq(quoteBToA.estimatedAmountIn));

          const preVaultBalanceA = new BN(
            await getTokenBalance(provider, poolInitInfo.tokenVaultAKeypair.publicKey),
          );
          const preVaultBalanceB = new BN(
            await getTokenBalance(provider, poolInitInfo.tokenVaultBKeypair.publicKey),
          );
          const preOwnerAccountBalanceA = new BN(await getTokenBalance(provider, tokenAccountA));
          const preOwnerAccountBalanceB = new BN(await getTokenBalance(provider, tokenAccountB));

          const sigBToA = await toTx(
            ctx,
            WhirlpoolIx.swapV2Ix(ctx.program, {
              ...quoteBToA,
              amount: inputAmount, // transfer fee included
              otherAmountThreshold: transferFeeExcludedOutputAmount.amount, // transfer fee excluded

              whirlpool: whirlpoolPda.publicKey,
              tokenAuthority: ctx.wallet.publicKey,
              tokenMintA: poolInitInfo.tokenMintA,
              tokenMintB: poolInitInfo.tokenMintB,
              tokenProgramA: poolInitInfo.tokenProgramA,
              tokenProgramB: poolInitInfo.tokenProgramB,
              tokenOwnerAccountA: tokenAccountA,
              tokenVaultA: poolInitInfo.tokenVaultAKeypair.publicKey,
              tokenOwnerAccountB: tokenAccountB,
              tokenVaultB: poolInitInfo.tokenVaultBKeypair.publicKey,
              oracle: oraclePubkey,
            }),
          ).buildAndExecute();

          const postVaultBalanceA = new BN(
            await getTokenBalance(provider, poolInitInfo.tokenVaultAKeypair.publicKey),
          );
          const postVaultBalanceB = new BN(
            await getTokenBalance(provider, poolInitInfo.tokenVaultBKeypair.publicKey),
          );
          const postOwnerAccountBalanceA = new BN(await getTokenBalance(provider, tokenAccountA));
          const postOwnerAccountBalanceB = new BN(await getTokenBalance(provider, tokenAccountB));

          assert.ok(postVaultBalanceA.sub(preVaultBalanceA).eq(expectedVaultAccountADelta));
          assert.ok(postVaultBalanceB.sub(preVaultBalanceB).eq(expectedVaultAccountBDelta));
          assert.ok(
            postOwnerAccountBalanceA.sub(preOwnerAccountBalanceA).eq(expectedOwnerAccountADelta),
          );
          assert.ok(
            postOwnerAccountBalanceB.sub(preOwnerAccountBalanceB).eq(expectedOwnerAccountBDelta),
          );
        });

        it("A --> B, ExactOut", async () => {
          const whirlpoolKey = poolInitInfo.whirlpoolPda.publicKey;
          const whirlpoolData = (await fetcher.getPool(
            whirlpoolKey,
            IGNORE_CACHE,
          )) as WhirlpoolData;

          const aToB = true;
          const outputAmount = new BN(2000000);
          const transferFeeIncludedOutputAmount = transferFeeB
            ? calculateTransferFeeIncludedAmount(transferFeeB, outputAmount)
            : { amount: outputAmount, fee: ZERO_BN };
          if (transferFeeB && transferFeeB.transferFeeBasisPoints > 0)
            assert.ok(transferFeeIncludedOutputAmount.fee.gtn(0));

          const quoteAToB = swapQuoteWithParams(
            {
              // A --> B, ExactOut
              amountSpecifiedIsInput: false,
              aToB,
              tokenAmount: transferFeeIncludedOutputAmount.amount,

              otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(false),
              sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToB),
              whirlpoolData,
              tickArrays: await SwapUtils.getTickArrays(
                whirlpoolData.tickCurrentIndex,
                whirlpoolData.tickSpacing,
                aToB,
                ctx.program.programId,
                whirlpoolKey,
                fetcher,
                IGNORE_CACHE,
              ),
            },
            Percentage.fromFraction(0, 100), // 0% slippage
          );

          const transferFeeIncludedInputAmount = transferFeeA
            ? calculateTransferFeeIncludedAmount(transferFeeA, quoteAToB.estimatedAmountIn)
            : { amount: quoteAToB.estimatedAmountIn, fee: ZERO_BN };
          if (transferFeeA && transferFeeA.transferFeeBasisPoints > 0)
            assert.ok(transferFeeIncludedInputAmount.fee.gtn(0));

          const expectedOwnerAccountADelta = transferFeeIncludedInputAmount.amount.neg(); // out
          const expectedOwnerAccountBDelta = outputAmount; // in
          const expectedVaultAccountADelta = quoteAToB.estimatedAmountIn; // in
          const expectedVaultAccountBDelta = transferFeeIncludedOutputAmount.amount.neg(); // out
          assert.ok(expectedVaultAccountADelta.eq(quoteAToB.estimatedAmountIn));
          assert.ok(expectedVaultAccountBDelta.eq(quoteAToB.estimatedAmountOut.neg()));

          const preVaultBalanceA = new BN(
            await getTokenBalance(provider, poolInitInfo.tokenVaultAKeypair.publicKey),
          );
          const preVaultBalanceB = new BN(
            await getTokenBalance(provider, poolInitInfo.tokenVaultBKeypair.publicKey),
          );
          const preOwnerAccountBalanceA = new BN(await getTokenBalance(provider, tokenAccountA));
          const preOwnerAccountBalanceB = new BN(await getTokenBalance(provider, tokenAccountB));

          const sigAToB = await toTx(
            ctx,
            WhirlpoolIx.swapV2Ix(ctx.program, {
              ...quoteAToB,
              amount: outputAmount, // transfer fee excluded
              otherAmountThreshold: transferFeeIncludedInputAmount.amount, // transfer fee included

              whirlpool: whirlpoolPda.publicKey,
              tokenAuthority: ctx.wallet.publicKey,
              tokenMintA: poolInitInfo.tokenMintA,
              tokenMintB: poolInitInfo.tokenMintB,
              tokenProgramA: poolInitInfo.tokenProgramA,
              tokenProgramB: poolInitInfo.tokenProgramB,
              tokenOwnerAccountA: tokenAccountA,
              tokenVaultA: poolInitInfo.tokenVaultAKeypair.publicKey,
              tokenOwnerAccountB: tokenAccountB,
              tokenVaultB: poolInitInfo.tokenVaultBKeypair.publicKey,
              oracle: oraclePubkey,
            }),
          ).buildAndExecute();

          const postVaultBalanceA = new BN(
            await getTokenBalance(provider, poolInitInfo.tokenVaultAKeypair.publicKey),
          );
          const postVaultBalanceB = new BN(
            await getTokenBalance(provider, poolInitInfo.tokenVaultBKeypair.publicKey),
          );
          const postOwnerAccountBalanceA = new BN(await getTokenBalance(provider, tokenAccountA));
          const postOwnerAccountBalanceB = new BN(await getTokenBalance(provider, tokenAccountB));

          assert.ok(postVaultBalanceA.sub(preVaultBalanceA).eq(expectedVaultAccountADelta));
          assert.ok(postVaultBalanceB.sub(preVaultBalanceB).eq(expectedVaultAccountBDelta));
          assert.ok(
            postOwnerAccountBalanceA.sub(preOwnerAccountBalanceA).eq(expectedOwnerAccountADelta),
          );
          assert.ok(
            postOwnerAccountBalanceB.sub(preOwnerAccountBalanceB).eq(expectedOwnerAccountBDelta),
          );
        });

        it("A <-- B, ExactOut", async () => {
          const whirlpoolKey = poolInitInfo.whirlpoolPda.publicKey;
          const whirlpoolData = (await fetcher.getPool(
            whirlpoolKey,
            IGNORE_CACHE,
          )) as WhirlpoolData;

          const aToB = false;
          const outputAmount = new BN(100000);
          const transferFeeIncludedOutputAmount = transferFeeA
            ? calculateTransferFeeIncludedAmount(transferFeeA, outputAmount)
            : { amount: outputAmount, fee: ZERO_BN };
          if (transferFeeA && transferFeeA.transferFeeBasisPoints > 0)
            assert.ok(transferFeeIncludedOutputAmount.fee.gtn(0));

          const quoteBToA = swapQuoteWithParams(
            {
              // A <-- B, ExactOut
              amountSpecifiedIsInput: false,
              aToB,
              tokenAmount: transferFeeIncludedOutputAmount.amount,

              otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(false),
              sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToB),
              whirlpoolData,
              tickArrays: await SwapUtils.getTickArrays(
                whirlpoolData.tickCurrentIndex,
                whirlpoolData.tickSpacing,
                aToB,
                ctx.program.programId,
                whirlpoolKey,
                fetcher,
                IGNORE_CACHE,
              ),
            },
            Percentage.fromFraction(0, 100), // 0% slippage
          );

          const transferFeeIncludedInputAmount = transferFeeB
            ? calculateTransferFeeIncludedAmount(transferFeeB, quoteBToA.estimatedAmountIn)
            : { amount: quoteBToA.estimatedAmountIn, fee: ZERO_BN };
          if (transferFeeB && transferFeeB.transferFeeBasisPoints > 0)
            assert.ok(transferFeeIncludedInputAmount.fee.gtn(0));

          const expectedOwnerAccountADelta = outputAmount; // in
          const expectedOwnerAccountBDelta = transferFeeIncludedInputAmount.amount.neg(); // out
          const expectedVaultAccountADelta = transferFeeIncludedOutputAmount.amount.neg(); // out
          const expectedVaultAccountBDelta = quoteBToA.estimatedAmountIn; // in
          assert.ok(expectedVaultAccountADelta.eq(quoteBToA.estimatedAmountOut.neg()));
          assert.ok(expectedVaultAccountBDelta.eq(quoteBToA.estimatedAmountIn));

          const preVaultBalanceA = new BN(
            await getTokenBalance(provider, poolInitInfo.tokenVaultAKeypair.publicKey),
          );
          const preVaultBalanceB = new BN(
            await getTokenBalance(provider, poolInitInfo.tokenVaultBKeypair.publicKey),
          );
          const preOwnerAccountBalanceA = new BN(await getTokenBalance(provider, tokenAccountA));
          const preOwnerAccountBalanceB = new BN(await getTokenBalance(provider, tokenAccountB));

          const sigAToB = await toTx(
            ctx,
            WhirlpoolIx.swapV2Ix(ctx.program, {
              ...quoteBToA,
              amount: outputAmount, // transfer fee excluded
              otherAmountThreshold: transferFeeIncludedInputAmount.amount, // transfer fee included

              whirlpool: whirlpoolPda.publicKey,
              tokenAuthority: ctx.wallet.publicKey,
              tokenMintA: poolInitInfo.tokenMintA,
              tokenMintB: poolInitInfo.tokenMintB,
              tokenProgramA: poolInitInfo.tokenProgramA,
              tokenProgramB: poolInitInfo.tokenProgramB,
              tokenOwnerAccountA: tokenAccountA,
              tokenVaultA: poolInitInfo.tokenVaultAKeypair.publicKey,
              tokenOwnerAccountB: tokenAccountB,
              tokenVaultB: poolInitInfo.tokenVaultBKeypair.publicKey,
              oracle: oraclePubkey,
            }),
          ).buildAndExecute();

          const postVaultBalanceA = new BN(
            await getTokenBalance(provider, poolInitInfo.tokenVaultAKeypair.publicKey),
          );
          const postVaultBalanceB = new BN(
            await getTokenBalance(provider, poolInitInfo.tokenVaultBKeypair.publicKey),
          );
          const postOwnerAccountBalanceA = new BN(await getTokenBalance(provider, tokenAccountA));
          const postOwnerAccountBalanceB = new BN(await getTokenBalance(provider, tokenAccountB));

          assert.ok(postVaultBalanceA.sub(preVaultBalanceA).eq(expectedVaultAccountADelta));
          assert.ok(postVaultBalanceB.sub(preVaultBalanceB).eq(expectedVaultAccountBDelta));
          assert.ok(
            postOwnerAccountBalanceA.sub(preOwnerAccountBalanceA).eq(expectedOwnerAccountADelta),
          );
          assert.ok(
            postOwnerAccountBalanceB.sub(preOwnerAccountBalanceB).eq(expectedOwnerAccountBDelta),
          );
        });
      });
    });
  });

  describe("two_hop_swap", () => {
    let aqConfig: InitAquariumV2Params;
    let aquarium: TestAquarium;
    let whirlpoolOneKey: PublicKey;
    let whirlpoolTwoKey: PublicKey;
    let whirlpoolDataOne: WhirlpoolData;
    let whirlpoolDataTwo: WhirlpoolData;

    const variations: TokenTrait[][] = [
      // all token has transfer fee
      [
        { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 300 },
        { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 500 },
        { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 1000 },
      ],
      // input token has transfer fee
      [
        { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 300 },
        { isToken2022: true, hasTransferFeeExtension: false },
        { isToken2022: true, hasTransferFeeExtension: false },
      ],
      // input and mid token has transfer fee
      [
        { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 300 },
        { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 500 },
        { isToken2022: true, hasTransferFeeExtension: false },
      ],
      // output token has transfer fee
      [
        { isToken2022: true, hasTransferFeeExtension: false },
        { isToken2022: true, hasTransferFeeExtension: false },
        { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 1000 },
      ],
      // output and mid token has transfer fee
      [
        { isToken2022: true, hasTransferFeeExtension: false },
        { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 500 },
        { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 1000 },
      ],
      // mid token has transfer fee
      [
        { isToken2022: true, hasTransferFeeExtension: false },
        { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 500 },
        { isToken2022: true, hasTransferFeeExtension: false },
      ],
      // input and output token has transfer fee
      [
        { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 300 },
        { isToken2022: true, hasTransferFeeExtension: false },
        { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 1000 },
      ],
      // all token has transfer fee, but bps are zero
      [
        { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 0 },
        { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 0 },
        { isToken2022: true, hasTransferFeeExtension: true, transferFeeInitialBps: 0 },
      ],
    ];

    variations.forEach(([token0, token1, token2]) => {
      const label0 = `Token0: transfer fee bps = ${
        token0.hasTransferFeeExtension ? token0.transferFeeInitialBps?.toString() : "none"
      }`;
      const label1 = `Token1: transfer fee bps = ${
        token1.hasTransferFeeExtension ? token1.transferFeeInitialBps?.toString() : "none"
      }`;
      const label2 = `Token2: transfer fee bps = ${
        token2.hasTransferFeeExtension ? token2.transferFeeInitialBps?.toString() : "none"
      }`;

      describe(`${label0}, ${label1}, ${label2}`, () => {
        beforeEach(async () => {
          aqConfig = getDefaultAquariumV2();
          // Add a third token and account and a second pool
          aqConfig.initMintParams = [
            { tokenTrait: token0 },
            { tokenTrait: token1 },
            { tokenTrait: token2 },
          ];
          aqConfig.initTokenAccParams.push({ mintIndex: 2 });
          aqConfig.initPoolParams.push({ mintIndices: [1, 2], tickSpacing: TickSpacing.Standard });

          // Add tick arrays and positions
          const aToB = false;
          aqConfig.initTickArrayRangeParams.push({
            poolIndex: 0,
            startTickIndex: 22528,
            arrayCount: 3,
            aToB,
          });
          aqConfig.initTickArrayRangeParams.push({
            poolIndex: 1,
            startTickIndex: 22528,
            arrayCount: 3,
            aToB,
          });
          const fundParams: FundedPositionV2Params[] = [
            {
              liquidityAmount: new anchor.BN(10_000_000),
              tickLowerIndex: 29440,
              tickUpperIndex: 33536,
            },
          ];
          aqConfig.initPositionParams.push({ poolIndex: 0, fundParams });
          aqConfig.initPositionParams.push({ poolIndex: 1, fundParams });

          aquarium = (await buildTestAquariumsV2(ctx, [aqConfig]))[0];
          const { pools } = aquarium;

          whirlpoolOneKey = pools[0].whirlpoolPda.publicKey;
          whirlpoolTwoKey = pools[1].whirlpoolPda.publicKey;
          whirlpoolDataOne = (await fetcher.getPool(
            whirlpoolOneKey,
            IGNORE_CACHE,
          )) as WhirlpoolData;
          whirlpoolDataTwo = (await fetcher.getPool(
            whirlpoolTwoKey,
            IGNORE_CACHE,
          )) as WhirlpoolData;
        });

        it("T0 --> T1 --> T2, ExactIn", async () => {
          const [inputToken, midToken, outputToken] = aquarium.mintKeys;
          const [inputTokenTrait, midTokenTrait, outputTokenTrait] = [token0, token1, token2];

          const transferFeeInput = inputTokenTrait.hasTransferFeeExtension ? await getTransferFee(inputToken) : null;
          const transferFeeMid = midTokenTrait.hasTransferFeeExtension ? await getTransferFee(midToken) : null;
          const transferFeeOutput = outputTokenTrait.hasTransferFeeExtension ? await getTransferFee(outputToken) : null;

          const inputAmount = new BN(1000);
          const transferFeeExcludedInputAmount = transferFeeInput
            ? calculateTransferFeeExcludedAmount(transferFeeInput, inputAmount)
            : { amount: inputAmount, fee: ZERO_BN };
          if (transferFeeInput && transferFeeInput.transferFeeBasisPoints > 0)
            assert.ok(transferFeeExcludedInputAmount.fee.gtn(0));

          const aToBOne = whirlpoolDataOne.tokenMintA.equals(inputToken);
          const quote = swapQuoteWithParams(
            {
              // T0 --> T1, ExactIn
              amountSpecifiedIsInput: true,
              aToB: aToBOne,
              tokenAmount: transferFeeExcludedInputAmount.amount,

              otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(true),
              sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToBOne),
              whirlpoolData: whirlpoolDataOne,
              tickArrays: await SwapUtils.getTickArrays(
                whirlpoolDataOne.tickCurrentIndex,
                whirlpoolDataOne.tickSpacing,
                aToBOne,
                ctx.program.programId,
                whirlpoolOneKey,
                fetcher,
                IGNORE_CACHE,
              ),
            },
            Percentage.fromFraction(0, 100),
          );

          // vault -> owner
          const transferFeeExcludedMidOutputAmount = transferFeeMid
            ? calculateTransferFeeExcludedAmount(transferFeeMid, quote.estimatedAmountOut)
            : { amount: quote.estimatedAmountOut, fee: ZERO_BN };
          if (transferFeeMid && transferFeeMid.transferFeeBasisPoints > 0)
            assert.ok(transferFeeExcludedMidOutputAmount.fee.gtn(0));

          // owner -> vault
          const transferFeeExcludedMidInputAmount = transferFeeMid
            ? calculateTransferFeeExcludedAmount(transferFeeMid, transferFeeExcludedMidOutputAmount.amount)
            : { amount: transferFeeExcludedMidOutputAmount.amount, fee: ZERO_BN };
          if (transferFeeMid && transferFeeMid.transferFeeBasisPoints > 0)
            assert.ok(transferFeeExcludedMidInputAmount.fee.gtn(0));

          const aToBTwo = whirlpoolDataTwo.tokenMintA.equals(midToken);
          const quote2 = swapQuoteWithParams(
            {
              // T1 --> T2, ExactIn
              amountSpecifiedIsInput: true,
              aToB: aToBTwo,
              tokenAmount: transferFeeExcludedMidInputAmount.amount,

              otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(true),
              sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToBTwo),
              whirlpoolData: whirlpoolDataTwo,
              tickArrays: await SwapUtils.getTickArrays(
                whirlpoolDataTwo.tickCurrentIndex,
                whirlpoolDataTwo.tickSpacing,
                aToBTwo,
                ctx.program.programId,
                whirlpoolTwoKey,
                fetcher,
                IGNORE_CACHE,
              ),
            },
            Percentage.fromFraction(0, 100),
          );

          const transferFeeExcludedOutputAmount = transferFeeOutput
           ? calculateTransferFeeExcludedAmount(transferFeeOutput, quote2.estimatedAmountOut)
            : { amount: quote2.estimatedAmountOut, fee: ZERO_BN };
          if (transferFeeOutput && transferFeeOutput.transferFeeBasisPoints > 0)
            assert.ok(transferFeeExcludedOutputAmount.fee.gtn(0));

          const expectedOwnerAccountInputDelta = inputAmount.neg(); // out
          const expectedOwnerAccountMidDelta = ZERO_BN; // in = out
          const expectedOwnerAccountOutputDelta = transferFeeExcludedOutputAmount.amount; // in
          const [expectedVaultAccountOneADelta, expectedVaultAccountOneBDelta] = aToBOne
            ? [transferFeeExcludedInputAmount.amount, quote.estimatedAmountOut.neg()]
            : [quote.estimatedAmountOut.neg(), transferFeeExcludedInputAmount.amount];
          const [expectedVaultAccountTwoADelta, expectedVaultAccountTwoBDelta] = aToBTwo
            ? [transferFeeExcludedMidInputAmount.amount, quote2.estimatedAmountOut.neg()]
            : [quote2.estimatedAmountOut.neg(), transferFeeExcludedMidInputAmount.amount];
          assert.ok(expectedVaultAccountOneADelta.eq(aToBOne ? quote.estimatedAmountIn : quote.estimatedAmountOut.neg()));
          assert.ok(expectedVaultAccountOneBDelta.eq(aToBOne ? quote.estimatedAmountOut.neg() : quote.estimatedAmountIn));
          assert.ok(expectedVaultAccountTwoADelta.eq(aToBTwo ? quote2.estimatedAmountIn : quote2.estimatedAmountOut.neg()));
          assert.ok(expectedVaultAccountTwoBDelta.eq(aToBTwo ? quote2.estimatedAmountOut.neg() : quote2.estimatedAmountIn));

          const pools = aquarium.pools;
          const tokenAccKeys = getTokenAccsForPoolsV2(pools, aquarium.tokenAccounts);
          const twoHopQuote = twoHopSwapQuoteFromSwapQuotes(quote, quote2);
          const baseIxParams: TwoHopSwapV2Params = {
            ...twoHopQuote,
            amount: inputAmount, // transfer fee included
            otherAmountThreshold: transferFeeExcludedOutputAmount.amount, // transfer fee excluded

            tokenAuthority: ctx.wallet.publicKey,
            whirlpoolOne: pools[0].whirlpoolPda.publicKey,
            whirlpoolTwo: pools[1].whirlpoolPda.publicKey,
            tokenMintOneA: pools[0].tokenMintA,
            tokenMintOneB: pools[0].tokenMintB,
            tokenMintTwoA: pools[1].tokenMintA,
            tokenMintTwoB: pools[1].tokenMintB,
            tokenProgramOneA: pools[0].tokenProgramA,
            tokenProgramOneB: pools[0].tokenProgramB,
            tokenProgramTwoA: pools[1].tokenProgramA,
            tokenProgramTwoB: pools[1].tokenProgramB,
            tokenOwnerAccountOneA: tokenAccKeys[0],
            tokenVaultOneA: pools[0].tokenVaultAKeypair.publicKey,
            tokenOwnerAccountOneB: tokenAccKeys[1],
            tokenVaultOneB: pools[0].tokenVaultBKeypair.publicKey,
            tokenOwnerAccountTwoA: tokenAccKeys[2],
            tokenVaultTwoA: pools[1].tokenVaultAKeypair.publicKey,
            tokenOwnerAccountTwoB: tokenAccKeys[3],
            tokenVaultTwoB: pools[1].tokenVaultBKeypair.publicKey,
            oracleOne: PDAUtil.getOracle(ctx.program.programId, pools[0].whirlpoolPda.publicKey)
              .publicKey,
            oracleTwo: PDAUtil.getOracle(ctx.program.programId, pools[1].whirlpoolPda.publicKey)
              .publicKey,
          };

          const [tokenAccountIn, tokenAccountMid] = baseIxParams.aToBOne
            ? [baseIxParams.tokenOwnerAccountOneA, baseIxParams.tokenOwnerAccountOneB]
            : [baseIxParams.tokenOwnerAccountOneB, baseIxParams.tokenOwnerAccountOneA];
          const tokenAccountOut = baseIxParams.aToBTwo
            ? baseIxParams.tokenOwnerAccountTwoB
            : baseIxParams.tokenOwnerAccountTwoA;
    
          const preVaultBalanceOneA = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultOneA));
          const preVaultBalanceOneB = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultOneB));
          const preVaultBalanceTwoA = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultTwoA));
          const preVaultBalanceTwoB = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultTwoB));
          const preOwnerAccountBalanceInput = new BN(await getTokenBalance(provider, tokenAccountIn));
          const preOwnerAccountBalanceMid = new BN(await getTokenBalance(provider, tokenAccountMid));
          const preOwnerAccountBalanceOutput = new BN(await getTokenBalance(provider, tokenAccountOut));

          const sig = await toTx(
            ctx,
            WhirlpoolIx.twoHopSwapV2Ix(ctx.program, baseIxParams)
          ).buildAndExecute();

          const postVaultBalanceOneA = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultOneA));
          const postVaultBalanceOneB = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultOneB));
          const postVaultBalanceTwoA = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultTwoA));
          const postVaultBalanceTwoB = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultTwoB));
          const postOwnerAccountBalanceInput = new BN(await getTokenBalance(provider, tokenAccountIn));
          const postOwnerAccountBalanceMid = new BN(await getTokenBalance(provider, tokenAccountMid));
          const postOwnerAccountBalanceOutput = new BN(await getTokenBalance(provider, tokenAccountOut));

          assert.ok(postVaultBalanceOneA.sub(preVaultBalanceOneA).eq(expectedVaultAccountOneADelta));
          assert.ok(postVaultBalanceOneB.sub(preVaultBalanceOneB).eq(expectedVaultAccountOneBDelta));
          assert.ok(postVaultBalanceTwoA.sub(preVaultBalanceTwoA).eq(expectedVaultAccountTwoADelta));
          assert.ok(postVaultBalanceTwoB.sub(preVaultBalanceTwoB).eq(expectedVaultAccountTwoBDelta));
          assert.ok(postOwnerAccountBalanceInput.sub(preOwnerAccountBalanceInput).eq(expectedOwnerAccountInputDelta));
          assert.ok(postOwnerAccountBalanceMid.sub(preOwnerAccountBalanceMid).eq(expectedOwnerAccountMidDelta));
          assert.ok(postOwnerAccountBalanceOutput.sub(preOwnerAccountBalanceOutput).eq(expectedOwnerAccountOutputDelta));

          //console.log(`aToB: ${aToBOne} ${aToBTwo}`);
          //console.log("in", transferFeeExcludedInputAmount.amount.toString(), transferFeeExcludedInputAmount.fee.toString());
          //console.log("midout", transferFeeExcludedMidOutputAmount.amount.toString(), transferFeeExcludedMidOutputAmount.fee.toString());
          //console.log("midin", transferFeeExcludedMidInputAmount.amount.toString(), transferFeeExcludedMidInputAmount.fee.toString());
          //console.log("out", transferFeeExcludedOutputAmount.amount.toString(), transferFeeExcludedOutputAmount.fee.toString());
          //console.log("q1", quote.estimatedAmountIn.toString(), quote.estimatedAmountOut.toString());
          //console.log("q2", quote2.estimatedAmountIn.toString(), quote2.estimatedAmountOut.toString());
        });

        it("T0 <-- T1 <-- T2, ExactIn", async () => {
          const [outputToken, midToken, inputToken] = aquarium.mintKeys;
          const [outputTokenTrait, midTokenTrait, inputTokenTrait] = [token0, token1, token2];

          const transferFeeInput = inputTokenTrait.hasTransferFeeExtension ? await getTransferFee(inputToken) : null;
          const transferFeeMid = midTokenTrait.hasTransferFeeExtension ? await getTransferFee(midToken) : null;
          const transferFeeOutput = outputTokenTrait.hasTransferFeeExtension ? await getTransferFee(outputToken) : null;

          const inputAmount = new BN(100000);
          const transferFeeExcludedInputAmount = transferFeeInput
            ? calculateTransferFeeExcludedAmount(transferFeeInput, inputAmount)
            : { amount: inputAmount, fee: ZERO_BN };
          if (transferFeeInput && transferFeeInput.transferFeeBasisPoints > 0)
            assert.ok(transferFeeExcludedInputAmount.fee.gtn(0));

          const aToBTwo = whirlpoolDataTwo.tokenMintA.equals(inputToken);
          const quote = swapQuoteWithParams(
            {
              // T1 <-- T2, ExactIn
              amountSpecifiedIsInput: true,
              aToB: aToBTwo,
              tokenAmount: transferFeeExcludedInputAmount.amount,

              otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(true),
              sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToBTwo),
              whirlpoolData: whirlpoolDataTwo,
              tickArrays: await SwapUtils.getTickArrays(
                whirlpoolDataTwo.tickCurrentIndex,
                whirlpoolDataTwo.tickSpacing,
                aToBTwo,
                ctx.program.programId,
                whirlpoolTwoKey,
                fetcher,
                IGNORE_CACHE,
              ),
            },
            Percentage.fromFraction(0, 100),
          );

          // vault -> owner
          const transferFeeExcludedMidOutputAmount = transferFeeMid
            ? calculateTransferFeeExcludedAmount(transferFeeMid, quote.estimatedAmountOut)
            : { amount: quote.estimatedAmountOut, fee: ZERO_BN };
          if (transferFeeMid && transferFeeMid.transferFeeBasisPoints > 0)
            assert.ok(transferFeeExcludedMidOutputAmount.fee.gtn(0));

          // owner -> vault
          const transferFeeExcludedMidInputAmount = transferFeeMid
            ? calculateTransferFeeExcludedAmount(transferFeeMid, transferFeeExcludedMidOutputAmount.amount)
            : { amount: transferFeeExcludedMidOutputAmount.amount, fee: ZERO_BN };
          if (transferFeeMid && transferFeeMid.transferFeeBasisPoints > 0)
            assert.ok(transferFeeExcludedMidInputAmount.fee.gtn(0));

          const aToBOne = whirlpoolDataOne.tokenMintA.equals(midToken);
          const quote2 = swapQuoteWithParams(
            {
              // T0 <-- T1, ExactIn
              amountSpecifiedIsInput: true,
              aToB: aToBOne,
              tokenAmount: transferFeeExcludedMidInputAmount.amount,

              otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(true),
              sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToBOne),
              whirlpoolData: whirlpoolDataOne,
              tickArrays: await SwapUtils.getTickArrays(
                whirlpoolDataOne.tickCurrentIndex,
                whirlpoolDataOne.tickSpacing,
                aToBOne,
                ctx.program.programId,
                whirlpoolOneKey,
                fetcher,
                IGNORE_CACHE,
              ),
            },
            Percentage.fromFraction(0, 100),
          );

          const transferFeeExcludedOutputAmount = transferFeeOutput
           ? calculateTransferFeeExcludedAmount(transferFeeOutput, quote2.estimatedAmountOut)
            : { amount: quote2.estimatedAmountOut, fee: ZERO_BN };
          if (transferFeeOutput && transferFeeOutput.transferFeeBasisPoints > 0)
            assert.ok(transferFeeExcludedOutputAmount.fee.gtn(0));

          const expectedOwnerAccountInputDelta = inputAmount.neg(); // out
          const expectedOwnerAccountMidDelta = ZERO_BN; // in = out
          const expectedOwnerAccountOutputDelta = transferFeeExcludedOutputAmount.amount; // in
          const [expectedVaultAccountOneADelta, expectedVaultAccountOneBDelta] = aToBOne
            ? [transferFeeExcludedInputAmount.amount, quote.estimatedAmountOut.neg()]
            : [quote.estimatedAmountOut.neg(), transferFeeExcludedInputAmount.amount];
          const [expectedVaultAccountTwoADelta, expectedVaultAccountTwoBDelta] = aToBTwo
            ? [transferFeeExcludedMidInputAmount.amount, quote2.estimatedAmountOut.neg()]
            : [quote2.estimatedAmountOut.neg(), transferFeeExcludedMidInputAmount.amount];
          assert.ok(expectedVaultAccountOneADelta.eq(aToBOne ? quote.estimatedAmountIn : quote.estimatedAmountOut.neg()));
          assert.ok(expectedVaultAccountOneBDelta.eq(aToBOne ? quote.estimatedAmountOut.neg() : quote.estimatedAmountIn));
          assert.ok(expectedVaultAccountTwoADelta.eq(aToBTwo ? quote2.estimatedAmountIn : quote2.estimatedAmountOut.neg()));
          assert.ok(expectedVaultAccountTwoBDelta.eq(aToBTwo ? quote2.estimatedAmountOut.neg() : quote2.estimatedAmountIn));

          const pools = aquarium.pools;
          const tokenAccKeys = getTokenAccsForPoolsV2(pools, aquarium.tokenAccounts);
          const twoHopQuote = twoHopSwapQuoteFromSwapQuotes(quote, quote2);
          const baseIxParams: TwoHopSwapV2Params = {
            ...twoHopQuote,
            amount: inputAmount, // transfer fee included
            otherAmountThreshold: transferFeeExcludedOutputAmount.amount, // transfer fee excluded

            tokenAuthority: ctx.wallet.publicKey,
            whirlpoolOne: pools[1].whirlpoolPda.publicKey,
            whirlpoolTwo: pools[0].whirlpoolPda.publicKey,
            tokenMintOneA: pools[1].tokenMintA,
            tokenMintOneB: pools[1].tokenMintB,
            tokenMintTwoA: pools[0].tokenMintA,
            tokenMintTwoB: pools[0].tokenMintB,
            tokenProgramOneA: pools[1].tokenProgramA,
            tokenProgramOneB: pools[1].tokenProgramB,
            tokenProgramTwoA: pools[0].tokenProgramA,
            tokenProgramTwoB: pools[0].tokenProgramB,
            tokenOwnerAccountOneA: tokenAccKeys[2],
            tokenVaultOneA: pools[1].tokenVaultAKeypair.publicKey,
            tokenOwnerAccountOneB: tokenAccKeys[3],
            tokenVaultOneB: pools[1].tokenVaultBKeypair.publicKey,
            tokenOwnerAccountTwoA: tokenAccKeys[0],
            tokenVaultTwoA: pools[0].tokenVaultAKeypair.publicKey,
            tokenOwnerAccountTwoB: tokenAccKeys[1],
            tokenVaultTwoB: pools[0].tokenVaultBKeypair.publicKey,
            oracleOne: PDAUtil.getOracle(ctx.program.programId, pools[1].whirlpoolPda.publicKey)
              .publicKey,
            oracleTwo: PDAUtil.getOracle(ctx.program.programId, pools[0].whirlpoolPda.publicKey)
              .publicKey,
          };

          const [tokenAccountIn, tokenAccountMid] = baseIxParams.aToBOne
            ? [baseIxParams.tokenOwnerAccountOneA, baseIxParams.tokenOwnerAccountOneB]
            : [baseIxParams.tokenOwnerAccountOneB, baseIxParams.tokenOwnerAccountOneA];
          const tokenAccountOut = baseIxParams.aToBTwo
            ? baseIxParams.tokenOwnerAccountTwoB
            : baseIxParams.tokenOwnerAccountTwoA;
    
          const preVaultBalanceOneA = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultOneA));
          const preVaultBalanceOneB = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultOneB));
          const preVaultBalanceTwoA = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultTwoA));
          const preVaultBalanceTwoB = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultTwoB));
          const preOwnerAccountBalanceInput = new BN(await getTokenBalance(provider, tokenAccountIn));
          const preOwnerAccountBalanceMid = new BN(await getTokenBalance(provider, tokenAccountMid));
          const preOwnerAccountBalanceOutput = new BN(await getTokenBalance(provider, tokenAccountOut));

          const sig = await toTx(
            ctx,
            WhirlpoolIx.twoHopSwapV2Ix(ctx.program, baseIxParams)
          ).buildAndExecute();

          const postVaultBalanceOneA = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultOneA));
          const postVaultBalanceOneB = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultOneB));
          const postVaultBalanceTwoA = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultTwoA));
          const postVaultBalanceTwoB = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultTwoB));
          const postOwnerAccountBalanceInput = new BN(await getTokenBalance(provider, tokenAccountIn));
          const postOwnerAccountBalanceMid = new BN(await getTokenBalance(provider, tokenAccountMid));
          const postOwnerAccountBalanceOutput = new BN(await getTokenBalance(provider, tokenAccountOut));

          assert.ok(postVaultBalanceOneA.sub(preVaultBalanceOneA).eq(expectedVaultAccountOneADelta));
          assert.ok(postVaultBalanceOneB.sub(preVaultBalanceOneB).eq(expectedVaultAccountOneBDelta));
          assert.ok(postVaultBalanceTwoA.sub(preVaultBalanceTwoA).eq(expectedVaultAccountTwoADelta));
          assert.ok(postVaultBalanceTwoB.sub(preVaultBalanceTwoB).eq(expectedVaultAccountTwoBDelta));
          assert.ok(postOwnerAccountBalanceInput.sub(preOwnerAccountBalanceInput).eq(expectedOwnerAccountInputDelta));
          assert.ok(postOwnerAccountBalanceMid.sub(preOwnerAccountBalanceMid).eq(expectedOwnerAccountMidDelta));
          assert.ok(postOwnerAccountBalanceOutput.sub(preOwnerAccountBalanceOutput).eq(expectedOwnerAccountOutputDelta));

          //console.log(`aToB: ${aToBTwo} ${aToBOne}`);
          //console.log("in", transferFeeExcludedInputAmount.amount.toString(), transferFeeExcludedInputAmount.fee.toString());
          //console.log("midout", transferFeeExcludedMidOutputAmount.amount.toString(), transferFeeExcludedMidOutputAmount.fee.toString());
          //console.log("midin", transferFeeExcludedMidInputAmount.amount.toString(), transferFeeExcludedMidInputAmount.fee.toString());
          //console.log("out", transferFeeExcludedOutputAmount.amount.toString(), transferFeeExcludedOutputAmount.fee.toString());
          //console.log("q1", quote.estimatedAmountIn.toString(), quote.estimatedAmountOut.toString());
          //console.log("q2", quote2.estimatedAmountIn.toString(), quote2.estimatedAmountOut.toString());
        })

        it("T0 --> T1 --> T2, ExactOut", async () => {
          const [inputToken, midToken, outputToken] = aquarium.mintKeys;
          const [inputTokenTrait, midTokenTrait, outputTokenTrait] = [token0, token1, token2];

          const transferFeeInput = inputTokenTrait.hasTransferFeeExtension ? await getTransferFee(inputToken) : null;
          const transferFeeMid = midTokenTrait.hasTransferFeeExtension ? await getTransferFee(midToken) : null;
          const transferFeeOutput = outputTokenTrait.hasTransferFeeExtension ? await getTransferFee(outputToken) : null;

          const outputAmount = new BN(500000);
          const transferFeeIncludedOutputAmount = transferFeeOutput
            ? calculateTransferFeeIncludedAmount(transferFeeOutput, outputAmount)
            : { amount: outputAmount, fee: ZERO_BN };
          if (transferFeeOutput && transferFeeOutput.transferFeeBasisPoints > 0)
            assert.ok(transferFeeIncludedOutputAmount.fee.gtn(0));

          const aToBTwo = whirlpoolDataTwo.tokenMintB.equals(outputToken);
          const quote2 = swapQuoteWithParams(
            {
              // T1 --> T2, ExactOut
              amountSpecifiedIsInput: false,
              aToB: aToBTwo,
              tokenAmount: transferFeeIncludedOutputAmount.amount,

              otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(false),
              sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToBTwo),
              whirlpoolData: whirlpoolDataTwo,
              tickArrays: await SwapUtils.getTickArrays(
                whirlpoolDataTwo.tickCurrentIndex,
                whirlpoolDataTwo.tickSpacing,
                aToBTwo,
                ctx.program.programId,
                whirlpoolTwoKey,
                fetcher,
                IGNORE_CACHE,
              ),
            },
            Percentage.fromFraction(0, 100),
          );

          // owner -> vault
          const transferFeeIncludedMidInputAmount = transferFeeMid
            ? calculateTransferFeeIncludedAmount(transferFeeMid, quote2.estimatedAmountIn)
            : { amount: quote2.estimatedAmountIn, fee: ZERO_BN };
          if (transferFeeMid && transferFeeMid.transferFeeBasisPoints > 0)
            assert.ok(transferFeeIncludedMidInputAmount.fee.gtn(0));

          // vault -> owner
          const transferFeeIncludedMidOutputAmount = transferFeeMid
            ? calculateTransferFeeIncludedAmount(transferFeeMid, transferFeeIncludedMidInputAmount.amount)
            : { amount: transferFeeIncludedMidInputAmount.amount, fee: ZERO_BN };
          if (transferFeeMid && transferFeeMid.transferFeeBasisPoints > 0)
            assert.ok(transferFeeIncludedMidOutputAmount.fee.gtn(0));

          const aToBOne = whirlpoolDataOne.tokenMintB.equals(midToken);
          const quote = swapQuoteWithParams(
            {
              // T0 --> T1, ExactOut
              amountSpecifiedIsInput: false,
              aToB: aToBOne,
              tokenAmount: transferFeeIncludedMidOutputAmount.amount,

              otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(false),
              sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToBOne),
              whirlpoolData: whirlpoolDataOne,
              tickArrays: await SwapUtils.getTickArrays(
                whirlpoolDataOne.tickCurrentIndex,
                whirlpoolDataOne.tickSpacing,
                aToBOne,
                ctx.program.programId,
                whirlpoolOneKey,
                fetcher,
                IGNORE_CACHE,
              ),
            },
            Percentage.fromFraction(0, 100),
          );

          const transferFeeIncludedInputAmount = transferFeeInput
           ? calculateTransferFeeIncludedAmount(transferFeeInput, quote.estimatedAmountIn)
            : { amount: quote.estimatedAmountIn, fee: ZERO_BN };
          if (transferFeeInput && transferFeeInput.transferFeeBasisPoints > 0)
            assert.ok(transferFeeIncludedInputAmount.fee.gtn(0));

          const expectedOwnerAccountInputDelta = transferFeeIncludedInputAmount.amount.neg(); // out
          const expectedOwnerAccountMidDelta = ZERO_BN; // in = out
          const expectedOwnerAccountOutputDelta = outputAmount; // in
          const [expectedVaultAccountOneADelta, expectedVaultAccountOneBDelta] = aToBOne
            ? [quote.estimatedAmountIn, transferFeeIncludedMidOutputAmount.amount.neg()]
            : [transferFeeIncludedMidOutputAmount.amount.neg(), quote.estimatedAmountIn];
          const [expectedVaultAccountTwoADelta, expectedVaultAccountTwoBDelta] = aToBTwo
            ? [quote2.estimatedAmountIn, transferFeeIncludedOutputAmount.amount.neg()]
            : [transferFeeIncludedOutputAmount.amount.neg(), quote2.estimatedAmountIn];
          assert.ok(expectedVaultAccountOneADelta.eq(aToBOne ? quote.estimatedAmountIn : quote.estimatedAmountOut.neg()));
          assert.ok(expectedVaultAccountOneBDelta.eq(aToBOne ? quote.estimatedAmountOut.neg() : quote.estimatedAmountIn));
          assert.ok(expectedVaultAccountTwoADelta.eq(aToBTwo ? quote2.estimatedAmountIn : quote2.estimatedAmountOut.neg()));
          assert.ok(expectedVaultAccountTwoBDelta.eq(aToBTwo ? quote2.estimatedAmountOut.neg() : quote2.estimatedAmountIn));

          const pools = aquarium.pools;
          const tokenAccKeys = getTokenAccsForPoolsV2(pools, aquarium.tokenAccounts);
          const twoHopQuote = twoHopSwapQuoteFromSwapQuotes(quote, quote2);
          const baseIxParams: TwoHopSwapV2Params = {
            ...twoHopQuote,
            amount: outputAmount, // transfer fee excluded
            otherAmountThreshold: transferFeeIncludedInputAmount.amount, // transfer fee included

            tokenAuthority: ctx.wallet.publicKey,
            whirlpoolOne: pools[0].whirlpoolPda.publicKey,
            whirlpoolTwo: pools[1].whirlpoolPda.publicKey,
            tokenMintOneA: pools[0].tokenMintA,
            tokenMintOneB: pools[0].tokenMintB,
            tokenMintTwoA: pools[1].tokenMintA,
            tokenMintTwoB: pools[1].tokenMintB,
            tokenProgramOneA: pools[0].tokenProgramA,
            tokenProgramOneB: pools[0].tokenProgramB,
            tokenProgramTwoA: pools[1].tokenProgramA,
            tokenProgramTwoB: pools[1].tokenProgramB,
            tokenOwnerAccountOneA: tokenAccKeys[0],
            tokenVaultOneA: pools[0].tokenVaultAKeypair.publicKey,
            tokenOwnerAccountOneB: tokenAccKeys[1],
            tokenVaultOneB: pools[0].tokenVaultBKeypair.publicKey,
            tokenOwnerAccountTwoA: tokenAccKeys[2],
            tokenVaultTwoA: pools[1].tokenVaultAKeypair.publicKey,
            tokenOwnerAccountTwoB: tokenAccKeys[3],
            tokenVaultTwoB: pools[1].tokenVaultBKeypair.publicKey,
            oracleOne: PDAUtil.getOracle(ctx.program.programId, pools[0].whirlpoolPda.publicKey)
              .publicKey,
            oracleTwo: PDAUtil.getOracle(ctx.program.programId, pools[1].whirlpoolPda.publicKey)
              .publicKey,
          };

          const [tokenAccountIn, tokenAccountMid] = baseIxParams.aToBOne
            ? [baseIxParams.tokenOwnerAccountOneA, baseIxParams.tokenOwnerAccountOneB]
            : [baseIxParams.tokenOwnerAccountOneB, baseIxParams.tokenOwnerAccountOneA];
          const tokenAccountOut = baseIxParams.aToBTwo
            ? baseIxParams.tokenOwnerAccountTwoB
            : baseIxParams.tokenOwnerAccountTwoA;
    
          const preVaultBalanceOneA = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultOneA));
          const preVaultBalanceOneB = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultOneB));
          const preVaultBalanceTwoA = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultTwoA));
          const preVaultBalanceTwoB = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultTwoB));
          const preOwnerAccountBalanceInput = new BN(await getTokenBalance(provider, tokenAccountIn));
          const preOwnerAccountBalanceMid = new BN(await getTokenBalance(provider, tokenAccountMid));
          const preOwnerAccountBalanceOutput = new BN(await getTokenBalance(provider, tokenAccountOut));

          const sig = await toTx(
            ctx,
            WhirlpoolIx.twoHopSwapV2Ix(ctx.program, baseIxParams)
          ).buildAndExecute(undefined, {skipPreflight: true});

          const postVaultBalanceOneA = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultOneA));
          const postVaultBalanceOneB = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultOneB));
          const postVaultBalanceTwoA = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultTwoA));
          const postVaultBalanceTwoB = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultTwoB));
          const postOwnerAccountBalanceInput = new BN(await getTokenBalance(provider, tokenAccountIn));
          const postOwnerAccountBalanceMid = new BN(await getTokenBalance(provider, tokenAccountMid));
          const postOwnerAccountBalanceOutput = new BN(await getTokenBalance(provider, tokenAccountOut));

          assert.ok(postVaultBalanceOneA.sub(preVaultBalanceOneA).eq(expectedVaultAccountOneADelta));
          assert.ok(postVaultBalanceOneB.sub(preVaultBalanceOneB).eq(expectedVaultAccountOneBDelta));
          assert.ok(postVaultBalanceTwoA.sub(preVaultBalanceTwoA).eq(expectedVaultAccountTwoADelta));
          assert.ok(postVaultBalanceTwoB.sub(preVaultBalanceTwoB).eq(expectedVaultAccountTwoBDelta));
          assert.ok(postOwnerAccountBalanceInput.sub(preOwnerAccountBalanceInput).eq(expectedOwnerAccountInputDelta));
          assert.ok(postOwnerAccountBalanceMid.sub(preOwnerAccountBalanceMid).eq(expectedOwnerAccountMidDelta));
          assert.ok(postOwnerAccountBalanceOutput.sub(preOwnerAccountBalanceOutput).eq(expectedOwnerAccountOutputDelta));

          //console.log(`aToB: ${aToBOne} ${aToBTwo}`);
          //console.log("out", transferFeeIncludedOutputAmount.amount.toString(), transferFeeIncludedOutputAmount.fee.toString());
          //console.log("midin", transferFeeIncludedMidInputAmount.amount.toString(), transferFeeIncludedMidInputAmount.fee.toString());
          //console.log("midout", transferFeeIncludedMidOutputAmount.amount.toString(), transferFeeIncludedMidOutputAmount.fee.toString());
          //console.log("in", transferFeeIncludedInputAmount.amount.toString(), transferFeeIncludedInputAmount.fee.toString());
          //console.log("q2", quote2.estimatedAmountIn.toString(), quote2.estimatedAmountOut.toString());
          //console.log("q1", quote.estimatedAmountIn.toString(), quote.estimatedAmountOut.toString());
        });

        it("T0 <-- T1 <-- T2, ExactOut", async () => {
          const [outputToken, midToken, inputToken] = aquarium.mintKeys;
          const [outputTokenTrait, midTokenTrait, inputTokenTrait] = [token0, token1, token2];

          const transferFeeInput = inputTokenTrait.hasTransferFeeExtension ? await getTransferFee(inputToken) : null;
          const transferFeeMid = midTokenTrait.hasTransferFeeExtension ? await getTransferFee(midToken) : null;
          const transferFeeOutput = outputTokenTrait.hasTransferFeeExtension ? await getTransferFee(outputToken) : null;

          const outputAmount = new BN(1000);
          const transferFeeIncludedOutputAmount = transferFeeOutput
            ? calculateTransferFeeIncludedAmount(transferFeeOutput, outputAmount)
            : { amount: outputAmount, fee: ZERO_BN };
          if (transferFeeOutput && transferFeeOutput.transferFeeBasisPoints > 0)
            assert.ok(transferFeeIncludedOutputAmount.fee.gtn(0));

          const aToBTwo = whirlpoolDataOne.tokenMintB.equals(outputToken);
          const quote2 = swapQuoteWithParams(
            {
              // T0 <-- T1, ExactOut
              amountSpecifiedIsInput: false,
              aToB: aToBTwo,
              tokenAmount: transferFeeIncludedOutputAmount.amount,

              otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(false),
              sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToBTwo),
              whirlpoolData: whirlpoolDataOne,
              tickArrays: await SwapUtils.getTickArrays(
                whirlpoolDataOne.tickCurrentIndex,
                whirlpoolDataOne.tickSpacing,
                aToBTwo,
                ctx.program.programId,
                whirlpoolOneKey,
                fetcher,
                IGNORE_CACHE,
              ),
            },
            Percentage.fromFraction(0, 100),
          );

          // owner -> vault
          const transferFeeIncludedMidInputAmount = transferFeeMid
            ? calculateTransferFeeIncludedAmount(transferFeeMid, quote2.estimatedAmountIn)
            : { amount: quote2.estimatedAmountIn, fee: ZERO_BN };
          if (transferFeeMid && transferFeeMid.transferFeeBasisPoints > 0)
            assert.ok(transferFeeIncludedMidInputAmount.fee.gtn(0));

          // vault -> owner
          const transferFeeIncludedMidOutputAmount = transferFeeMid
            ? calculateTransferFeeIncludedAmount(transferFeeMid, transferFeeIncludedMidInputAmount.amount)
            : { amount: transferFeeIncludedMidInputAmount.amount, fee: ZERO_BN };
          if (transferFeeMid && transferFeeMid.transferFeeBasisPoints > 0)
            assert.ok(transferFeeIncludedMidOutputAmount.fee.gtn(0));

          const aToBOne = whirlpoolDataTwo.tokenMintB.equals(midToken);
          const quote = swapQuoteWithParams(
            {
              // T1 <-- T2, ExactOut
              amountSpecifiedIsInput: false,
              aToB: aToBOne,
              tokenAmount: transferFeeIncludedMidOutputAmount.amount,

              otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(false),
              sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToBOne),
              whirlpoolData: whirlpoolDataTwo,
              tickArrays: await SwapUtils.getTickArrays(
                whirlpoolDataTwo.tickCurrentIndex,
                whirlpoolDataTwo.tickSpacing,
                aToBOne,
                ctx.program.programId,
                whirlpoolTwoKey,
                fetcher,
                IGNORE_CACHE,
              ),
            },
            Percentage.fromFraction(0, 100),
          );

          const transferFeeIncludedInputAmount = transferFeeInput
           ? calculateTransferFeeIncludedAmount(transferFeeInput, quote.estimatedAmountIn)
            : { amount: quote.estimatedAmountIn, fee: ZERO_BN };
          if (transferFeeInput && transferFeeInput.transferFeeBasisPoints > 0)
            assert.ok(transferFeeIncludedInputAmount.fee.gtn(0));

          const expectedOwnerAccountInputDelta = transferFeeIncludedInputAmount.amount.neg(); // out
          const expectedOwnerAccountMidDelta = ZERO_BN; // in = out
          const expectedOwnerAccountOutputDelta = outputAmount; // in
          const [expectedVaultAccountTwoADelta, expectedVaultAccountTwoBDelta] = aToBTwo
            ? [quote2.estimatedAmountIn, transferFeeIncludedOutputAmount.amount.neg()]
            : [transferFeeIncludedOutputAmount.amount.neg(), quote2.estimatedAmountIn];
          const [expectedVaultAccountOneADelta, expectedVaultAccountOneBDelta] = aToBOne
            ? [quote.estimatedAmountIn, transferFeeIncludedMidOutputAmount.amount.neg()]
            : [transferFeeIncludedMidOutputAmount.amount.neg(), quote.estimatedAmountIn];
          assert.ok(expectedVaultAccountTwoADelta.eq(aToBTwo ? quote2.estimatedAmountIn : quote2.estimatedAmountOut.neg()));
          assert.ok(expectedVaultAccountTwoBDelta.eq(aToBTwo ? quote2.estimatedAmountOut.neg() : quote2.estimatedAmountIn));
          assert.ok(expectedVaultAccountOneADelta.eq(aToBOne ? quote.estimatedAmountIn : quote.estimatedAmountOut.neg()));
          assert.ok(expectedVaultAccountOneBDelta.eq(aToBOne ? quote.estimatedAmountOut.neg() : quote.estimatedAmountIn));

          const pools = aquarium.pools;
          const tokenAccKeys = getTokenAccsForPoolsV2(pools, aquarium.tokenAccounts);
          const twoHopQuote = twoHopSwapQuoteFromSwapQuotes(quote, quote2);
          const baseIxParams: TwoHopSwapV2Params = {
            ...twoHopQuote,
            amount: outputAmount, // transfer fee excluded
            otherAmountThreshold: transferFeeIncludedInputAmount.amount, // transfer fee included

            tokenAuthority: ctx.wallet.publicKey,
            whirlpoolOne: pools[1].whirlpoolPda.publicKey,
            whirlpoolTwo: pools[0].whirlpoolPda.publicKey,
            tokenMintOneA: pools[1].tokenMintA,
            tokenMintOneB: pools[1].tokenMintB,
            tokenMintTwoA: pools[0].tokenMintA,
            tokenMintTwoB: pools[0].tokenMintB,
            tokenProgramOneA: pools[1].tokenProgramA,
            tokenProgramOneB: pools[1].tokenProgramB,
            tokenProgramTwoA: pools[0].tokenProgramA,
            tokenProgramTwoB: pools[0].tokenProgramB,
            tokenOwnerAccountOneA: tokenAccKeys[2],
            tokenVaultOneA: pools[1].tokenVaultAKeypair.publicKey,
            tokenOwnerAccountOneB: tokenAccKeys[3],
            tokenVaultOneB: pools[1].tokenVaultBKeypair.publicKey,
            tokenOwnerAccountTwoA: tokenAccKeys[0],
            tokenVaultTwoA: pools[0].tokenVaultAKeypair.publicKey,
            tokenOwnerAccountTwoB: tokenAccKeys[1],
            tokenVaultTwoB: pools[0].tokenVaultBKeypair.publicKey,
            oracleOne: PDAUtil.getOracle(ctx.program.programId, pools[1].whirlpoolPda.publicKey)
              .publicKey,
            oracleTwo: PDAUtil.getOracle(ctx.program.programId, pools[0].whirlpoolPda.publicKey)
              .publicKey,
          };

          const [tokenAccountIn, tokenAccountMid] = baseIxParams.aToBOne
            ? [baseIxParams.tokenOwnerAccountOneA, baseIxParams.tokenOwnerAccountOneB]
            : [baseIxParams.tokenOwnerAccountOneB, baseIxParams.tokenOwnerAccountOneA];
          const tokenAccountOut = baseIxParams.aToBTwo
            ? baseIxParams.tokenOwnerAccountTwoB
            : baseIxParams.tokenOwnerAccountTwoA;
    
          const preVaultBalanceOneA = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultOneA));
          const preVaultBalanceOneB = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultOneB));
          const preVaultBalanceTwoA = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultTwoA));
          const preVaultBalanceTwoB = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultTwoB));
          const preOwnerAccountBalanceInput = new BN(await getTokenBalance(provider, tokenAccountIn));
          const preOwnerAccountBalanceMid = new BN(await getTokenBalance(provider, tokenAccountMid));
          const preOwnerAccountBalanceOutput = new BN(await getTokenBalance(provider, tokenAccountOut));

          const sig = await toTx(
            ctx,
            WhirlpoolIx.twoHopSwapV2Ix(ctx.program, baseIxParams)
          ).buildAndExecute(undefined, {skipPreflight: true});

          const postVaultBalanceOneA = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultOneA));
          const postVaultBalanceOneB = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultOneB));
          const postVaultBalanceTwoA = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultTwoA));
          const postVaultBalanceTwoB = new BN(await getTokenBalance(provider, baseIxParams.tokenVaultTwoB));
          const postOwnerAccountBalanceInput = new BN(await getTokenBalance(provider, tokenAccountIn));
          const postOwnerAccountBalanceMid = new BN(await getTokenBalance(provider, tokenAccountMid));
          const postOwnerAccountBalanceOutput = new BN(await getTokenBalance(provider, tokenAccountOut));

          assert.ok(postVaultBalanceOneA.sub(preVaultBalanceOneA).eq(expectedVaultAccountOneADelta));
          assert.ok(postVaultBalanceOneB.sub(preVaultBalanceOneB).eq(expectedVaultAccountOneBDelta));
          assert.ok(postVaultBalanceTwoA.sub(preVaultBalanceTwoA).eq(expectedVaultAccountTwoADelta));
          assert.ok(postVaultBalanceTwoB.sub(preVaultBalanceTwoB).eq(expectedVaultAccountTwoBDelta));
          assert.ok(postOwnerAccountBalanceInput.sub(preOwnerAccountBalanceInput).eq(expectedOwnerAccountInputDelta));
          assert.ok(postOwnerAccountBalanceMid.sub(preOwnerAccountBalanceMid).eq(expectedOwnerAccountMidDelta));
          assert.ok(postOwnerAccountBalanceOutput.sub(preOwnerAccountBalanceOutput).eq(expectedOwnerAccountOutputDelta));

          //console.log(`aToB: ${aToBTwo} ${aToBOne}`);
          //console.log("out", transferFeeIncludedOutputAmount.amount.toString(), transferFeeIncludedOutputAmount.fee.toString());
          //console.log("midin", transferFeeIncludedMidInputAmount.amount.toString(), transferFeeIncludedMidInputAmount.fee.toString());
          //console.log("midout", transferFeeIncludedMidOutputAmount.amount.toString(), transferFeeIncludedMidOutputAmount.fee.toString());
          //console.log("in", transferFeeIncludedInputAmount.amount.toString(), transferFeeIncludedInputAmount.fee.toString());
          //console.log("q2", quote2.estimatedAmountIn.toString(), quote2.estimatedAmountOut.toString());
          //console.log("q1", quote.estimatedAmountIn.toString(), quote.estimatedAmountOut.toString());
        });
      });
    });
  });
});
