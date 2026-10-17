/**
 * Translates backend error messages for display.
 *
 * Backend errors are plain English strings. Rather than scatter translation logic
 * across every toast call, this helper centralises the mapping: known messages get
 * an i18n key, unknown ones pass through unchanged so nothing is ever swallowed.
 *
 * Usage:
 *   toast.error(translateError(error, t, t('common.operationFailed')));
 */
const ERROR_MAP = {
  // Auth
  'Invalid username/email or password.': 'err.invalidCredentials',
  'Invalid phone number or password.': 'err.invalidCredentials',
  'Enter your username or email, and your password.': 'err.loginFieldsRequired',
  'Phone number and password are required.': 'err.loginFieldsRequired',
  'Account is deactivated. Contact super admin.': 'err.accountDeactivated',
  'Your account is not active. Please contact the admin.': 'err.accountNotActive',
  'Login failed.': 'err.loginFailed',
  'Admin not found.': 'err.adminNotFound',
  'Failed to fetch profile.': 'err.profileFailed',
  'Current and new password are required.': 'err.passwordFieldsRequired',
  'New password must be at least 8 characters.': 'err.passwordTooShort',
  'Current password is incorrect.': 'err.currentPasswordWrong',
  'The new password must be different from your current one.': 'err.passwordReused',
  'The new passwords do not match.': 'err.passwordMismatch',
  'Your password must be changed before you can continue.': 'err.passwordChangeRequired',

  // Admins
  'All fields are required.': 'err.allFieldsRequired',
  'That username is already taken.': 'err.usernameTaken',
  'Email already exists.': 'err.emailExists',
  'You cannot delete your own account.': 'err.cannotDeleteSelf',

  // Members
  'Member not found.': 'err.memberNotFound',
  'This member has financial history and cannot be deleted. Deactivate instead.': 'err.memberHasHistory',
  'Cannot delete the last super admin.': 'err.cannotDeleteLastSuperAdmin',

  // Contributions
  'Member, amount, and date are required.': 'err.contributionFieldsRequired',
  'Contribution recorded successfully.': 'err.contributionRecorded',

  // Loans
  'Loan not found.': 'err.loanNotFound',
  'Member has an active loan.': 'err.activeLoanExists',
  'Loan amount exceeds the maximum allowed.': 'err.loanExceedsMax',
  'Loan application submitted.': 'err.loanSubmitted',
  'Loan approved.': 'err.loanApproved',
  'Loan rejected.': 'err.loanRejected',
  'Repayment recorded.': 'err.repaymentRecorded',

  // Settings
  'No setting called': 'err.settingNotFound',
  'must be one of': 'err.invalidValue',

  // M-Pesa
  'M-Pesa is not configured.': 'err.mpesaNotConfigured',
  'Could not reach Safaricom.': 'err.safaricomUnreachable',
};

/**
 * Extracts and translates an axios error message.
 *
 * @param {Error} error - The axios error object
 * @param {Function} t - The i18n translator
 * @param {string} fallback - Untranslated fallback if no message is found
 * @returns {string} The translated message
 */
export const translateError = (error, t, fallback) => {
  const raw = error?.response?.data?.error
    || error?.response?.data?.message
    || error?.message
    || fallback;

  // Look up the exact message
  const key = ERROR_MAP[raw];
  if (key) {
    try {
      return t(key);
    } catch {
      // Missing translation key — fall through to the raw message
    }
  }

  // Partial match for dynamic messages (e.g. "No setting called X exists.")
  for (const [pattern, tk] of Object.entries(ERROR_MAP)) {
    if (raw.startsWith(pattern.split(' ')[0]) && pattern.includes(raw.slice(0, 20))) {
      try {
        return t(tk);
      } catch {
        break;
      }
    }
  }

  return raw;
};
