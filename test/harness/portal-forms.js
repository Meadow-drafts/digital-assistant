// DOM fixtures that imitate the portal's forms. Field names are the ones the portal's own Formik forms use, read (not
// copied as code) from bpay-bicec/src: TRANSFER_KEYS in constants/transfer.js (account, mtrans, raison, ccptsou, tel,
// pin), BILL_KEYS in constants/bill.js (billRef, contractRef), and the form components under src/components
// (singleTransfer/TransactionInformation.jsx, ValueAddedServices/AirtimePayment.jsx, BillPayment/BillInformation.jsx,
// RequestToPay/RequestForm.jsx). Every form also carries the PIN, OTP and password inputs of the modals next to it, and
// buttons that record presses, so a test can prove they were never touched.
//
// Like the portal's React inputs, each field has an onChange that reads the value on `input` (text) or `change`
// (select), and a record of every event it received.
export const ACCOUNTS = [
  { value: '12345678901', label: 'Main account' },
  { value: '55500011122', label: 'Savings' },
];

const FIELDS = {
  single_transfer: [
    { tag: 'select', name: 'ccptsou', options: ACCOUNTS },
    { name: 'account' },
    { name: 'mtrans' },
    { name: 'raison' },
  ],
  airtime: [
    { tag: 'select', name: 'ccptsou', options: ACCOUNTS },
    { name: 'tel' },
    { name: 'mtrans' },
  ],
  bill_payment: [
    { tag: 'select', name: 'ccptsou', options: ACCOUNTS },
    { name: 'billRef' },
    { name: 'raison' },
  ],
  request_to_pay: [
    { name: 'account' },
    { name: 'mtrans' },
    { name: 'raison' },
  ],
};

// `omit` leaves out inputs (the portal shows some only after a choice); `disabled` renders them disabled, as the
// airtime form does until an operator card is picked.
export function mountPortalForm(document, form, { omit = [], disabled = [], extraSecret = {} } = {}) {
  const root = document.createElement('form');
  root.dataset.fixture = form;
  const state = { values: {}, events: {}, presses: [], submits: 0 };
  root.addEventListener('submit', (e) => { e.preventDefault(); state.submits += 1; });
  const add = (spec) => {
    const wrap = document.createElement('div');
    const label = document.createElement('label');
    label.textContent = spec.name;
    const el = document.createElement(spec.tag ?? 'input');
    el.name = spec.name;
    if (spec.type) el.type = spec.type;
    for (const o of spec.options ?? []) el.add(new document.defaultView.Option(o.label, o.value));
    if (disabled.includes(spec.name)) el.disabled = true;
    state.events[spec.name] = [];
    const record = (e) => { state.events[spec.name].push(e.type); state.values[spec.name] = el.value; };
    el.addEventListener('input', record);
    el.addEventListener('change', record);
    wrap.append(label, el);
    root.append(wrap);
    return el;
  };
  for (const spec of FIELDS[form]) if (!omit.includes(spec.name)) add(spec);
  // Never to be touched: the PIN modal, the OTP step, passwords, the cardless voucher code.
  const secrets = [
    { name: 'pin', type: 'password' },
    { name: 'otp' },
    { name: 'newPassword', type: 'password' },
    { name: 'vouchercode' },
    ...Object.entries(extraSecret).map(([name, type]) => ({ name, type })),
  ];
  for (const spec of secrets) add(spec);
  for (const name of ['Next', 'Proceed Transfer', 'Confirm', 'Send request']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.addEventListener('click', () => state.presses.push(name));
    root.append(button);
  }
  document.body.append(root);
  return { root, state, input: (name) => root.querySelector(`[name="${name}"]`) };
}
