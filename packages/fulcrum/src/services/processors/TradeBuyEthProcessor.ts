import { BigNumber } from "bignumber.js";
import { pTokenContract } from "../../contracts/pTokenContract";
import { RequestTask } from "../../domain/RequestTask";
import { TradeRequest } from "../../domain/TradeRequest";
import { TradeTokenKey } from "../../domain/TradeTokenKey";
import { FulcrumProviderEvents } from "../events/FulcrumProviderEvents";
import { FulcrumProvider } from "../FulcrumProvider";
import { SwapQuoter, SwapQuoteConsumer, SwapQuoteGetOutputOpts, ConsumerType } from '@0x/asset-swapper';
import { SupportedProvider } from "ethereum-types";
import { Asset } from "../../domain/Asset";


export class TradeBuyEthProcessor {
  public run = async (task: RequestTask, account: string, skipGas: boolean, supportedProvider: SupportedProvider) => {
    if (!(FulcrumProvider.Instance.contractsSource && FulcrumProvider.Instance.contractsSource.canWrite)) {
      throw new Error("No provider available!");
    }

    // Initializing loan
    const taskRequest: TradeRequest = (task.request as TradeRequest);
    const amountInBaseUnits = new BigNumber(taskRequest.amount.multipliedBy(10 ** 18).toFixed(0, 1)); // ETH -> 18 decimals
    console.log("amountInBaseUnits: ", amountInBaseUnits)
    const tokenContract: pTokenContract | null =
      await FulcrumProvider.Instance.contractsSource.getPTokenContract(
        new TradeTokenKey(
          taskRequest.asset,
          taskRequest.unitOfAccount,
          taskRequest.positionType,
          taskRequest.leverage,
          taskRequest.isTokenized,
          taskRequest.version
        )
      );
    if (!tokenContract) {
      throw new Error("No pToken contract available!");
    }

    task.processingStart([
      "Initializing",
      "Submitting trade",
      "Updating the blockchain",
      "Transaction completed"
    ]);

    // no additional inits or checks
    task.processingStepNext();

    let gasAmountBN;

    // Waiting for token allowance
    if (skipGas) {
      gasAmountBN = new BigNumber(2300000);
    } else {
      // estimating gas amount
      const gasAmount = await tokenContract.mintWithEther.estimateGasAsync(account, { from: account, value: amountInBaseUnits, gas: FulcrumProvider.Instance.gasLimit });
      gasAmountBN = new BigNumber(gasAmount).multipliedBy(FulcrumProvider.Instance.gasBufferCoeff).integerValue(BigNumber.ROUND_UP);
    }

    let txHash: string = "";
    try {
      FulcrumProvider.Instance.eventEmitter.emit(FulcrumProviderEvents.AskToOpenProgressDlg);

      const apiUrl = 'https://api.kovan.radarrelay.com/v2/';
      console.log(supportedProvider)

      const swapQuoter = SwapQuoter.getSwapQuoterForStandardRelayerAPIUrl(
        supportedProvider,
        apiUrl, {
        networkId: 42
      });

      const makerTokenAddress = FulcrumProvider.Instance.getErc20AddressOfAsset(taskRequest.asset);
      const takerTokenAddress = FulcrumProvider.Instance.getErc20AddressOfAsset(Asset.DAI);

      // Requesting a quote for buying amountInBaseUnits of ether
      const quote = await swapQuoter.getMarketBuySwapQuoteAsync(
        makerTokenAddress as string,
        takerTokenAddress as string,
        amountInBaseUnits
      );
      console.log(quote.orders);

      // Submitting trade
      // sends the transaction from user's unlocked account
      // transfers an amountInBaseUnits of ether
      // mints DAI?
      const swapQuoteConsumer = new SwapQuoteConsumer(supportedProvider);

      const calldataInfo = await swapQuoteConsumer.getCalldataOrThrowAsync(quote, {
        takerAddress: takerTokenAddress,
        useConsumerType: ConsumerType.Exchange,
      } as Partial<SwapQuoteGetOutputOpts>);

      const { calldataHexString } = calldataInfo;

      txHash = await tokenContract.mintWithEther.sendTransactionAsync(account, {
        from: account,
        value: amountInBaseUnits, // how much ether does it send?
        gas: gasAmountBN.toString(),
        gasPrice: await FulcrumProvider.Instance.gasPrice()
      });
      task.setTxHash(txHash);
    }
    finally {
      FulcrumProvider.Instance.eventEmitter.emit(FulcrumProviderEvents.AskToCloseProgressDlg);
    }

    task.processingStepNext();
    const txReceipt = await FulcrumProvider.Instance.waitForTransactionMined(txHash, task.request);
    if (!txReceipt.status) {
      throw new Error("Reverted by EVM");
    }

    task.processingStepNext();
    await FulcrumProvider.Instance.sleep(FulcrumProvider.Instance.successDisplayTimeout);
  }
}
