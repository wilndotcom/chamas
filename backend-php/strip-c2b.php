<?php

declare(strict_types=1);

/** Removes every C2B handler from the M-Pesa controller. Run once. */
$path = __DIR__ . '/app/Controllers/MpesaController.php';
$text = file_get_contents($path);
$before = strlen($text);

// registerC2BUrls: from its docblock to the start of the next docblock.
$text = preg_replace(
    "~\n    /\*\*\n     \* Registers the paybill's validation.*?\n    \}\n(?=\n    /\*\*)~s",
    '',
    $text,
    1
);

// c2bConfirmation + c2bValidation: everything between the two docblocks that
// follows the STK callback, up to the helpers divider.
$text = preg_replace(
    "~\n    /\*\*\n     \* The C2B confirmation Safaricom posts once money has been received\..*?\n    \}\n(?=\n    // -------------------------------------------------------------- helpers)~s",
    '',
    $text,
    1
);

file_put_contents($path, $text);

printf("removed %d characters\n", $before - strlen($text));
echo 'c2b references left: ' . preg_match_all('~c2bConfirmation|c2bValidation|registerC2BUrls~', $text) . "\n";