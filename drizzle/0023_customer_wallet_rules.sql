-- Feature 21 (customer wallet), custom migration: the rules Drizzle cannot express.
-- 1. "A customer wallet below zero is frozen": a deferred constraint trigger checks it at COMMIT, so the top-up chargeback clawback can
--    post first (taking the wallet below zero under the posting's lock) and freeze the same row afterwards in the same transaction. The
--    WHEN clause only decides, at the update, whether the commit-time check is queued, so ordinary postings pay nothing; the function
--    re-reads the row, so a freeze later in the transaction satisfies it. An unfreeze of a wallet below zero fails at commit.
-- 2. The English and Arabic default templates of the five wallet notification events (generated from CUSTOMER_WALLET_TEMPLATES in
--    src/modules/money/application/customer-wallet-notifications.ts; a spec keeps the two equal). A row that exists is left as it is.
CREATE FUNCTION "ledger_check_customer_wallet_frozen"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ledger_accounts" a WHERE a."id" = NEW."id" AND a."kind" = 'customer_wallet'
             AND a."balance" < 0 AND a."frozen_at" IS NULL) THEN
    RAISE EXCEPTION 'customer wallet % is below zero and not frozen', NEW."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_accounts_negative_customer_wallet_frozen';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "ledger_accounts_negative_customer_wallet_frozen" AFTER INSERT OR UPDATE ON "ledger_accounts"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."kind" = 'customer_wallet' AND NEW."balance" < 0)
  EXECUTE FUNCTION "ledger_check_customer_wallet_frozen"();--> statement-breakpoint
INSERT INTO "notification_templates" ("event", "channel", "audience", "locale", "subject", "body", "is_active") VALUES
  ('wallet.topup_credited', 'email', 'customer', 'en', 'Your balance was topped up', 'Hi {{customerName}},

We added {{amount}} to your store balance (top-up {{reference}}). Your balance is now {{balance}}.

If you did not make this top-up, reply to this email.', true),
  ('wallet.topup_credited', 'email', 'customer', 'ar', 'تم شحن رصيدك', 'مرحباً {{customerName}}،

أضفنا {{amount}} إلى رصيدك في المتجر (عملية الشحن {{reference}}). رصيدك الآن {{balance}}.

إذا لم تقم بهذه العملية، ردّ على هذه الرسالة.', true),
  ('wallet.topup_rejected', 'email', 'customer', 'en', 'We could not accept your top-up {{reference}}', 'Hi {{customerName}},

We could not accept your top-up of {{amount}} ({{reference}}).

Reason: {{reason}}

Nothing was added to your balance. You can start a new top-up, or reply to this email if you think this is a mistake.', true),
  ('wallet.topup_rejected', 'email', 'customer', 'ar', 'تعذّر قبول عملية الشحن {{reference}}', 'مرحباً {{customerName}}،

تعذّر علينا قبول عملية شحن الرصيد بمبلغ {{amount}} ({{reference}}).

السبب: {{reason}}

لم يُضَف أي مبلغ إلى رصيدك. يمكنك بدء عملية شحن جديدة، أو الرد على هذه الرسالة إذا كنت ترى أن هناك خطأ.', true),
  ('wallet.adjusted', 'email', 'customer', 'en', 'Your store balance changed', 'Hi {{customerName}},

Our team changed your store balance by {{change}}. Your balance is now {{balance}}.

If you did not expect this, reply to this email.', true),
  ('wallet.adjusted', 'email', 'customer', 'ar', 'تغيّر رصيدك في المتجر', 'مرحباً {{customerName}}،

عدّل فريقنا رصيدك في المتجر بمقدار {{change}}. رصيدك الآن {{balance}}.

إذا لم تكن تتوقع ذلك، ردّ على هذه الرسالة.', true),
  ('wallet.frozen', 'email', 'customer', 'en', 'Your store balance is on hold', 'Hi {{customerName}},

Paying from your store balance is on hold while we review a payment on your account. Your orders and your sign-in are not affected.

Reply to this email if you need help.', true),
  ('wallet.frozen', 'email', 'customer', 'ar', 'رصيدك في المتجر موقوف مؤقتاً', 'مرحباً {{customerName}}،

أوقفنا الدفع من رصيدك في المتجر مؤقتاً ريثما نراجع عملية دفع في حسابك. طلباتك وتسجيل دخولك لا يتأثران.

ردّ على هذه الرسالة إذا احتجت إلى مساعدة.', true),
  ('wallet.order_refunded', 'email', 'customer', 'en', 'We returned {{amount}} to your store balance', 'Hi {{customerName}},

We refunded {{amount}} for order {{orderId}} ("{{service}}") to your store balance. You can use it for another order.', true),
  ('wallet.order_refunded', 'email', 'customer', 'ar', 'أعدنا {{amount}} إلى رصيدك في المتجر', 'مرحباً {{customerName}}،

أعدنا {{amount}} عن الطلب {{orderId}} («{{service}}») إلى رصيدك في المتجر. يمكنك استخدامه في طلب آخر.', true)
ON CONFLICT ("event", "channel", "audience", "locale") DO NOTHING;
