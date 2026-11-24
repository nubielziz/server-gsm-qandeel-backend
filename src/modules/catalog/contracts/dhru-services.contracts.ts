// Route contract of the Dhru action `imeiservicelist` (map domain B, stage 7, decision 026): the keys are the standard's (`LIST`,
// `GROUPNAME`, `SERVICES`, `SERVICEID`, `Requires.*`).
import { z } from 'zod';
import { zMoney } from '../../../common/contract';
import { defineDhruAction } from '../../../common/dhru';

/** One custom input of a service as the Dhru list describes it. */
const DhruCustomField = z.object({
  type: z.string().describe('`serviceimei`, `serviceserver` or `serviceremote`.'),
  fieldname: z.string().describe('The field key: the name `CUSTOMFIELD` takes.'),
  fieldtype: z.enum(['text', 'textarea', 'dropdown']),
  description: z.string().describe('The label.'),
  fieldoptions: z.string().describe('The choices of a dropdown, comma separated; `""` otherwise.'),
  required: z.union([z.literal(1), z.literal(0)]),
});

/** One service of the Dhru list. */
const DhruService = z.object({
  SERVICEID: z.string().describe('Our service id: the `ID` of `placeimeiorder`.'),
  SERVICETYPE: z.enum(['IMEI', 'SERVER', 'REMOTE']),
  SERVICENAME: z.string(),
  CREDIT: zMoney.describe("The merchant's price."),
  INFO: z.string(),
  TIME: z.string().describe('The delivery time, `15 min`, `2 hours`.'),
  QNT: z.enum(['0', '1']).describe('`1` when the service sells more than one quantity.'),
  QNTOPTIONS: z.string().describe('The packs a service sells, comma separated; `""` when it sells a range.'),
  MINQNT: z.string(),
  MAXQNT: z.string(),
  'Requires.Network': z.string(),
  'Requires.Mobile': z.string(),
  'Requires.Provider': z.string(),
  'Requires.PIN': z.string(),
  'Requires.KBH': z.string(),
  'Requires.MEP': z.string(),
  'Requires.PRD': z.string(),
  'Requires.Type': z.string(),
  'Requires.Locks': z.string(),
  'Requires.SN': z.string(),
  'Requires.SecRO': z.string(),
  'Requires.Reference': z.string(),
  'Requires.Custom': z.array(DhruCustomField),
});

const DHRU_EXAMPLE_SERVICE = {
  SERVICEID: '5',
  SERVICETYPE: 'IMEI',
  SERVICENAME: 'AT&T USA Unlock',
  CREDIT: '16.9300',
  INFO: '',
  TIME: '1 day',
  QNT: '0',
  QNTOPTIONS: '',
  MINQNT: '1',
  MAXQNT: '1',
  'Requires.Network': 'None',
  'Requires.Mobile': 'None',
  'Requires.Provider': 'None',
  'Requires.PIN': 'None',
  'Requires.KBH': 'None',
  'Requires.MEP': 'None',
  'Requires.PRD': 'None',
  'Requires.Type': 'None',
  'Requires.Locks': 'None',
  'Requires.SN': 'None',
  'Requires.SecRO': 'None',
  'Requires.Reference': 'None',
  'Requires.Custom': [],
} as const;

/** The Dhru action `imeiservicelist`: the services grouped by category, at the merchant's prices. */
export const dhruServiceList = defineDhruAction({
  key: 'DHRU imeiservicelist',
  summary: 'IMEI service list',
  description:
    'The IMEI, server and remote services the merchant may order, grouped by category, at its own price (`CREDIT`), with the quantity ' +
    'rules and the custom fields (`Requires.Custom`). File services are not listed. Archived and disabled services and categories the ' +
    "merchant's group may not see are never listed. Every price shown is remembered as the merchant's listed price (user rule 9).",
  success: z.object({
    MESSAGE: z.literal('IMEI Service List'),
    LIST: z.record(
      z.string(),
      z.object({
        GROUPNAME: z.string(),
        GROUPTYPE: z.enum(['IMEI', 'SERVER', 'REMOTE']),
        SERVICES: z.record(z.string(), DhruService),
      }),
    ),
  }),
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_PENDING_APPROVAL', 'IP_NOT_ALLOWED', 'RATE_LIMITED'],
  examples: {
    response: {
      MESSAGE: 'IMEI Service List',
      LIST: {
        'Carrier unlock': {
          GROUPNAME: 'Carrier unlock',
          GROUPTYPE: 'IMEI',
          SERVICES: { '5': DHRU_EXAMPLE_SERVICE },
        },
      },
    },
  },
});
