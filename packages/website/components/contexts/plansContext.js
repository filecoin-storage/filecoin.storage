export const plans = [
  {
    id: 'free',
    title: 'Free',
    description: 'You are currently on the free tier. You can use our service up to 5GB/mo without being charged.',
    price: '$0/mo',
    amount: '5GB per month',
    bandwidth: '10GB per month',
    overage: '$0.25 / GB',
    current: false,
  },
  {
    id: 'tier1',
    title: 'Lite',
    description: 'For those that want to take advantage of more storage',
    price: '$3/mo',
    amount: '15GB per month',
    bandwidth: '30GB per month',
    overage: '$0.20 / GB',
    current: true,
  },
  {
    id: 'tier2',
    title: 'Pro',
    description: 'All the sauce, all the toppings.',
    price: '$10/mo',
    amount: '60GB per month',
    bandwidth: '120GB per month',
    overage: '$0.17 / GB',
    current: false,
  },
  // {
  //   id: 'tier3',
  //   title: 'Enterprise',
  //   description: 'All the sauce, all the toppings.',
  //   price: 'Custom',
  //   amount: '60GB',
  //   bandwidth: '120GB',
  //   overage: '$.17 per GB',
  //   current: false,
  // },
];
