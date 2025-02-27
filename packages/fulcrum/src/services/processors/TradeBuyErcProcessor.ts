import { BigNumber } from "bignumber.js";
import { erc20Contract } from "../../contracts/erc20";
import { pTokenContract } from "../../contracts/pTokenContract";
import { AssetsDictionary } from "../../domain/AssetsDictionary";
import { RequestTask } from "../../domain/RequestTask";
import { TradeRequest } from "../../domain/TradeRequest";
import { TradeTokenKey } from "../../domain/TradeTokenKey";
import { FulcrumProviderEvents } from "../events/FulcrumProviderEvents";
import { FulcrumProvider } from "../FulcrumProvider";

export class TradeBuyErcProcessor {
  public run = async (task: RequestTask, account: string, skipGas: boolean) => {
    if (!(FulcrumProvider.Instance.contractsSource && FulcrumProvider.Instance.contractsSource.canWrite)) {
      throw new Error("No provider available!");
    }

    // Initializing loan
    const taskRequest: TradeRequest = (task.request as TradeRequest);
    const decimals: number = AssetsDictionary.assets.get(taskRequest.collateral)!.decimals || 18;
    const amountInBaseUnits = new BigNumber(taskRequest.amount.multipliedBy(10 ** decimals).toFixed(0, 1));
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
      "Detecting token allowance",
      "Prompting token allowance",
      "Waiting for token allowance",
      "Submitting trade",
      "Updating the blockchain",
      "Transaction completed"
    ]);

    // init erc20 contract for base token
    let tokenErc20Contract: erc20Contract | null = null;
    const assetErc20Address = FulcrumProvider.Instance.getErc20AddressOfAsset(taskRequest.collateral);
    if (assetErc20Address) {
      tokenErc20Contract = await FulcrumProvider.Instance.contractsSource.getErc20Contract(assetErc20Address);
    } else {
      throw new Error("No ERC20 contract available!");
    }

    if (!tokenErc20Contract) {
      throw new Error("No ERC20 contract available!");
    }
    task.processingStepNext();

    // Detecting token allowance
    const erc20allowance = await tokenErc20Contract.allowance.callAsync(account, tokenContract.address);
    task.processingStepNext();

    let txHash: string = "";
    let approvePromise: Promise<string> | null = null;
    try {
      FulcrumProvider.Instance.eventEmitter.emit(FulcrumProviderEvents.AskToOpenProgressDlg);

      // Prompting token allowance
      if (amountInBaseUnits.gt(erc20allowance)) {
        approvePromise = tokenErc20Contract.approve.sendTransactionAsync(tokenContract.address, FulcrumProvider.UNLIMITED_ALLOWANCE_IN_BASE_UNITS, { from: account });
      }
      task.processingStepNext();
      task.processingStepNext();

      let gasAmountBN;

      // Waiting for token allowance
      if (approvePromise || skipGas) {
        await approvePromise;
        gasAmountBN = new BigNumber(2300000);
      } else {
        // estimating gas amount
        const gasAmount = await tokenContract.mintWithToken.estimateGasAsync(account, assetErc20Address, amountInBaseUnits, {
          from: account,
          gas: FulcrumProvider.Instance.gasLimit
        });
        gasAmountBN = new BigNumber(gasAmount).multipliedBy(FulcrumProvider.Instance.gasBufferCoeff).integerValue(BigNumber.ROUND_UP);
      }

      // Submitting trade
      txHash = await tokenContract.mintWithToken.sendTransactionAsync(account, assetErc20Address, amountInBaseUnits, {
        from: account,
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
