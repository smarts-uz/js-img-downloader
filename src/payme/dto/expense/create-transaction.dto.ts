import { TransactionMethods } from '../../constants/transaction-methods';

export class CreateTransactionDto {
  method: TransactionMethods;
  params: {
    id: string;
    time: number;
    amount: number;
    account: {
      package_id: number;
      team_id: number;
    };
  };
}
