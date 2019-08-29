import { BigNumber } from "bignumber.js";
import { pTokenContract } from "../../contracts/pTokenContract";
import { AssetsDictionary } from "../../domain/AssetsDictionary";
import { RequestTask } from "../../domain/RequestTask";
import { TradeRequest } from "../../domain/TradeRequest";
import { TradeTokenKey } from "../../domain/TradeTokenKey";
import { FulcrumProviderEvents } from "../events/FulcrumProviderEvents";
import { FulcrumProvider } from "../FulcrumProvider";
import { UserOrderType } from "@radarrelay/types";

export class TradeBuyEthProcessor {
  public run = async (task: RequestTask, account: string, skipGas: boolean) => {
    if (!(FulcrumProvider.Instance.contractsSource && FulcrumProvider.Instance.contractsSource.canWrite)) {
      throw new Error("No provider available!");
    }

    // Initializing loan
    const taskRequest: TradeRequest = (task.request as TradeRequest);
    const amountInBaseUnits = new BigNumber(taskRequest.amount.multipliedBy(10 ** 18).toFixed(0, 1)); // ETH -> 18 decimals
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

    let asks = FulcrumProvider.Instance.markets['WETH-DAI'].orderBook.asks
    console.log(asks)

    let availableSupply
    if (asks.length > 1)
      // type availableSupply: (bidsOrAsks => float)
      availableSupply = asks
        .reduce((acc: any, currVal: any, currInd: number) => {
          return (
            currInd == 1
              ? parseFloat(acc.remainingBaseTokenAmount)
              : acc
          ) + parseFloat(currVal.remainingBaseTokenAmount)
        })

    else if (asks.length == 1)
      // type availableSupply: (bidsOrAsks array => float)
      availableSupply = asks[0].remainingBaseTokenAmount

    try {
      var remainingDemand = amountInBaseUnits.multipliedBy(taskRequest.leverage - 1)

      for (var i = 0; i < asks.length; i++) {
        let orderAmount = asks[i].remainingBaseTokenAmount;
        console.log('orderAmount', orderAmount)
        let BnOrderAmount = new BigNumber(orderAmount);
        console.log('BnOrderAmount', BnOrderAmount)
        await FulcrumProvider.Instance.markets['WETH-DAI'].marketData
          .marketOrderAsync(
            UserOrderType.BUY,
            BnOrderAmount
          )
        remainingDemand = remainingDemand.minus(orderAmount)
        availableSupply = availableSupply.minus(orderAmount)
        if (remainingDemand.isLessThanOrEqualTo(0) ||
          availableSupply.isLessThanOrEqualTo(0)
        ) break;
      }

    } catch (e) {
      console.log(e)
    }    

    let txHash: string = "";
    try {
      FulcrumProvider.Instance.eventEmitter.emit(FulcrumProviderEvents.AskToOpenProgressDlg);
      

      // Submitting trade
      // sends the transaction from user's unlocked account
      // transfers an amountInBaseUnits of ether
      // mints DAI?
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
