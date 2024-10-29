import { Injectable } from '@nestjs/common';
import { ClickRequestDto } from './dto/click-request.dto';
import { TransactionActions } from './constants/transaction-action';
import { PrismaService } from 'src/prisma.service';
import { HashingService } from 'src/utils/hashing/hashing.service';
import { ConfigService } from '@nestjs/config';
// import { Decimal } from '@prisma/client'; 
import { validate as isUuid } from 'uuid';
import { ClickError } from 'src/enum/Payment.enum';

@Injectable()
export class ClickService {
  private readonly secretKey: string;
  constructor(
    private readonly prismaService: PrismaService,
    private readonly hashingService: HashingService,
    private readonly configService: ConfigService,
  ) {
    this.secretKey = this.configService.get<string>('CLICK_SECRET');
  }

  async handleMerchantTransactions(clickReqBody: ClickRequestDto) {
    const actionType = +clickReqBody.action;

    clickReqBody.amount = parseFloat(clickReqBody.amount + '');

    switch (actionType) {
      case TransactionActions.Prepare:
        return this.prepare(clickReqBody);
      case TransactionActions.Complete:
        return this.complete(clickReqBody);
      default:
        return {
          error: ClickError.ActionNotFound,
          error_note: 'Invalid action',
        };
    }
  }

  async prepare(clickReqBody: ClickRequestDto) {
    const userId = clickReqBody.param2; // Assuming this is a string
    const amount = clickReqBody.amount; // Ensure amount is a number
    const transId = clickReqBody.click_trans_id + ''; // Ensure transId is a string
    const signString = clickReqBody.sign_string;
  
    // Prepare MD5 parameters
    const myMD5Params = {
      clickTransId: transId,
      serviceId: clickReqBody.service_id,
      secretKey: this.secretKey,
      merchantTransId: clickReqBody.merchant_trans_id,
      amount: amount, // Ensure it's a string if needed
      action: clickReqBody.action,
      signTime: clickReqBody.sign_time,
    };
    const myMD5Hash = this.hashingService.generateMD5(myMD5Params);

    if (signString !== myMD5Hash) {
      return {
        error: ClickError.SignFailed,
        error_note: 'Invalid sign_string',
      };
    }

    const isValidUserId = this.checkObjectId(userId);

    if (!isValidUserId) {
      return {
        error: ClickError.BadRequest,
        error_note: 'Invalid userId',
      };
    }

    const isAlreadyPaid = await this.prismaService.pay_balance.findFirst({
      where: {
        transaction_id: transId,
        status: 'PAID',
      },
    });

    if (isAlreadyPaid) {
      return {
        error: ClickError.AlreadyPaid,
        error_note: 'Already paid',
      };
    }

    const isCancelled = await this.prismaService.pay_balance.findFirst({
      where: {
        user_id: Number(userId),
        status: 'CANCELED',
      },
    });

    if (isCancelled) {
      return {
        error: ClickError.TransactionCanceled,
        error_note: 'Cancelled',
      };
    }

    const user = await this.prismaService.pay_balance.findUnique({
      where: {
        id: Number(userId),
      },
    });

    if (!user) {
      return {
        error: ClickError.UserNotFound,
        error_note: 'Invalid userId',
      };
    }

    const transaction = await this.prismaService.pay_balance.findUnique({
        where: {
          id: Number(transId), // Convert transId to number if it's the unique identifier
        },
      });

    if (transaction && transaction.status === 'CANCELED') {
      return {
        error: ClickError.TransactionCanceled,
        error_note: 'Transaction canceled',
      };
    }

    const time = new Date();

    await this.prismaService.pay_balance.create({
      data: {
        user_id: Number(userId),               
        transaction_id: transId,               
        prepareId: time.getTime(),              
        status: 'PENDING',                     
        system: 'Click',                       
        price: clickReqBody.amount, 
        createdAt: time,                        
        updatedAt: time,                      
        name: 'Your Name Here',                 
      },
    });

    return {
      click_trans_id: +transId,
      merchant_trans_id: clickReqBody.merchant_trans_id,
      merchant_prepare_id: time,
      error: ClickError.Success,
      error_note: 'Success',
    };
  }

  async complete(clickReqBody: ClickRequestDto) {
    const userId = clickReqBody.param2;
    const prepareId = clickReqBody.merchant_prepare_id;
    const transId = clickReqBody.click_trans_id + '';
    const amount = clickReqBody.amount;
    const signString = clickReqBody.sign_string;

    const myMD5Params = {
      clickTransId: transId,
      serviceId: clickReqBody.service_id,
      secretKey: this.secretKey,
      merchantTransId: clickReqBody.merchant_trans_id,
      merchantPrepareId: prepareId,
      amount,
      action: clickReqBody.action,
      signTime: clickReqBody.sign_time,
    };

    const myMD5Hash = this.hashingService.generateMD5(myMD5Params);

    if (signString !== myMD5Hash) {
      return {
        error: ClickError.SignFailed,
        error_note: 'Invalid sign_string',
      };
    }

    const isValidUserId = this.checkObjectId(userId);

    if (!isValidUserId) {
      return {
        error: ClickError.BadRequest,
        error_note: 'Invalid userId',
      };
    }

    const user = await this.prismaService.pay_balance.findUnique({
      where: {
        id: Number(userId),
      },
    });

    if (!user) {
      return {
        error: ClickError.UserNotFound,
        error_note: 'Invalid userId',
      };
    }

    const isPrepared = await this.prismaService.pay_balance.findFirst({
      where: {
        prepareId: +prepareId,
        user_id: Number(userId),
      },
    });

    if (!isPrepared) {
      return {
        error: ClickError.TransactionNotFound,
        error_note: 'Invalid merchant_prepare_id',
      };
    }

    const isAlreadyPaid = await this.prismaService.pay_balance.findFirst({
      where: {
        transaction_id: transId,
        prepareId: +prepareId,
        status: 'PAID',
      },
    });

    if (isAlreadyPaid) {
      return {
        error: ClickError.AlreadyPaid,
        error_note: 'Already paid',
      };
    }

    if (amount !== isPrepared.price.toNumber()) {
      return {
        error: ClickError.InvalidAmount,
        error_note: 'Invalid amount',
      };
    }

    if (clickReqBody.error > 0) {
      await this.prismaService.pay_balance.update({
        where: {
          id: isPrepared.id,
        },
        data: {
          status: 'CANCELED',
        },
      });
      return {
        error: clickReqBody.error,
        error_note: 'Failed',
      };
    }

    // Update payment status
    await this.prismaService.pay_balance.update({
      where: {
        id: isPrepared.id,
      },
      data: {
        status: 'PAID',
      },
    });

    return {
      click_trans_id: +transId,
      merchant_trans_id: clickReqBody.merchant_trans_id,
      error: ClickError.Success,
      error_note: 'Success',
    };
  }

  private checkObjectId(id: string) {
    return isUuid(id);
  }
}