// Hand-written fixture: the authority account is never checked to have signed.
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
};

entrypoint!(process_instruction);

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], _data: &[u8]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let vault = next_account_info(iter)?;
    let authority = next_account_info(iter)?;
    let recipient = next_account_info(iter)?;
    if vault.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let stored = Pubkey::new_from_array(vault.data.borrow()[0..32].try_into().unwrap());
    if stored != *authority.key {
        return Err(ProgramError::InvalidAccountData);
    }
    let amount = vault.lamports();
    **vault.try_borrow_mut_lamports()? -= amount;
    **recipient.try_borrow_mut_lamports()? += amount;
    Ok(())
}
